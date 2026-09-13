#!/usr/bin/env node
/**
 * 掃出「AI 解說主張的選項 ≠ 題庫標準答案」的快取解說。
 *
 * 為什麼重要：使用者回報「答案有誤」時，實際比對考選部答案卷後發現答案是對的
 * （2026-09-13，34 題實質不符 0 題）。真正的問題是**解說在論證另一個選項**，
 * 使用者看到解說跟答案打架，自然認為答案錯了。
 * 解說自相矛盾比答案錯更傷信任——它同時否定了答案和解說。
 *
 * 偵測方式：解說開頭固定是 `**✅ 為什麼答案是 X**`，取出 X 跟題庫答案比。
 * 只認這個明確的標頭，抓不到就跳過（寧可漏報也不要誤判）。
 *
 * 用法：
 *   node scripts/scan-explanation-mismatch.js            # 統計 + 樣本
 *   node scripts/scan-explanation-mismatch.js --delete   # 刪掉矛盾的快取，讓它重新生成
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..');
const DELETE = process.argv.includes('--delete');

fs.readFileSync(path.join(DIR, '.env'), 'utf-8').split('\n').forEach(l => {
  const i = l.indexOf('=');
  if (i > 0 && !l.trim().startsWith('#')) process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
});
const supabase = require(path.join(DIR, 'supabase'));

// examId -> 題庫檔
const EXAM_FILE = {};
for (const f of fs.readdirSync(DIR).filter(x => /^questions(-.*)?\.json$/.test(x) && !/\.bak/.test(x))) {
  EXAM_FILE[f === 'questions.json' ? 'doctor1' : f.replace('questions-', '').replace('.json', '')] = f;
}

// `${examId}:${questionId}` -> { answer, where }
const answers = new Map();
for (const [examId, f] of Object.entries(EXAM_FILE)) {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  for (const q of (Array.isArray(j) ? j : j.questions) || []) {
    answers.set(`${examId}:${q.id}`, { answer: String(q.answer || '').trim(), where: `${q.roc_year}${q.session} #${q.number}` });
  }
}
console.log(`題庫答案索引 ${answers.size} 題\n`);

// 解說開頭的「為什麼答案是 X」
function claimedAnswer(md) {
  const m = String(md).match(/為什麼答案是\s*\*{0,2}\s*\(?([A-Da-d])\)?/);
  return m ? m[1].toUpperCase() : null;
}

(async () => {
  // 用 keyset 分頁（id > lastId），不要用 range offset —— offset 到兩萬筆就會
  // statement timeout，因為每次都要從頭數過去。
  // explanation_md 欄位很大，偶爾仍會 timeout，所以失敗時縮小頁數重試並從斷點續跑。
  const PAGE = 500;
  let lastKey = '', scanned = 0, noClaim = 0, noQuestion = 0, shared = 0;
  const bad = [];

  for (;;) {
    let data = null;
    for (let attempt = 0, size = PAGE; attempt < 5; attempt++, size = Math.max(40, Math.floor(size / 2))) {
      const res = await supabase
        .from('ai_explanations')
        .select('id,cache_key,explanation_md')
        .gt('cache_key', lastKey)
        .order('cache_key', { ascending: true })
        .limit(size);
      if (!res.error) { data = res.data; break; }
      if (attempt === 4) console.error(`放棄於 cache_key > ${lastKey}：${res.error.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!data || !data.length) break;
    lastKey = data[data.length - 1].cache_key;

    for (const r of data) {
      scanned++;
      const parts = String(r.cache_key).split(':');
      if (parts[0] !== 'exam') { shared++; continue; }
      const key = `${parts[1]}:${parts.slice(2).join(':')}`;
      const q = answers.get(key);
      if (!q) { noQuestion++; continue; }
      const claim = claimedAnswer(r.explanation_md);
      if (!claim) { noClaim++; continue; }
      // 題庫答案可能是多答案（B,C）或「送分」，只要解說主張的在裡面就算一致
      const ok = q.answer.split(/[,、\s]+/).filter(Boolean).includes(claim) || /送分/.test(q.answer);
      if (!ok) bad.push({ id: r.id, key: r.cache_key, exam: parts[1], where: q.where, ours: q.answer, claim });
    }

    if (data.length < 40) break;
    if (scanned % 20000 < PAGE) process.stderr.write(`  掃描中 ${scanned}…\n`);
  }

  console.log(`掃描 ${scanned} 筆快取解說`);
  console.log(`  shared bank（暫不處理） ${shared}`);
  console.log(`  題庫裡找不到該題        ${noQuestion}`);
  console.log(`  解說沒有明確標頭        ${noClaim}`);
  console.log(`\n⚠️ 解說與答案矛盾：${bad.length} 筆`);

  const per = {};
  for (const b of bad) per[b.exam] = (per[b.exam] || 0) + 1;
  Object.entries(per).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .forEach(([k, v]) => console.log(`  ${k.padEnd(22)}${v}`));

  console.log('\n樣本:');
  for (const b of bad.slice(0, 8)) console.log(`  [${b.exam}] ${b.where}  題庫答案=${b.ours} 解說主張=${b.claim}`);

  fs.writeFileSync(path.join(DIR, '_tmp', 'explanation-mismatch.json'), JSON.stringify(bad, null, 2), 'utf8');
  console.log('\n清單已寫出 _tmp/explanation-mismatch.json');

  if (DELETE && bad.length) {
    let ok = 0;
    for (let i = 0; i < bad.length; i += 100) {
      const ids = bad.slice(i, i + 100).map(b => b.id);
      const { error } = await supabase.from('ai_explanations').delete().in('id', ids);
      if (!error) ok += ids.length;
    }
    console.log(`\n✅ 已刪除 ${ok} 筆矛盾快取（下次有人看該題會重新生成）`);
  } else if (bad.length) {
    console.log('\n(唯讀。加 --delete 可刪掉矛盾快取讓它重新生成)');
  }
})();
