#!/usr/bin/env node
/**
 * 查「使用者回報的題，現在在題庫裡找不到」是怎麼回事。
 *
 * 待處理回報有一大批用題幹在現況題庫比對不到。可能原因差很多，後果也差很多：
 *   moved      題還在，但換到別的年份/題號 → 題號格子位移，不算遺失
 *   edited     題還在原位，但題幹被改過（修破損時順便改的）→ 其實已處理
 *   lost       整個題庫都找不到 → **題目遺失**，最嚴重
 *
 * 比對策略：完全比對 → 前綴比對（前 20 字）→ 都不中才算 lost。
 * 唯讀。
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..');
const norm = (t) => String(t).normalize('NFC').replace(/\s+/g, '');

fs.readFileSync(path.join(DIR, '.env'), 'utf-8').split('\n').forEach(l => {
  const i = l.indexOf('=');
  if (i > 0 && !l.trim().startsWith('#')) process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
});
const supabase = require(path.join(DIR, 'supabase'));

const exact = new Map();     // 完整題幹 -> 位置
const prefix = new Map();    // 前 20 字 -> [位置]
for (const f of fs.readdirSync(DIR).filter(x => /^questions(-.*)?\.json$/.test(x) && !/\.bak/.test(x))) {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const exam = f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '');
  for (const q of (Array.isArray(j) ? j : j.questions) || []) {
    const n = norm(q.question);
    const loc = { exam, id: q.id, where: `${q.roc_year}${q.session} #${q.number}`, text: n };
    exact.set(n, loc);
    const p = n.slice(0, 20);
    if (p.length >= 10) {
      if (!prefix.has(p)) prefix.set(p, []);
      prefix.get(p).push(loc);
    }
  }
}
console.log(`題庫索引：完整 ${exact.size} 題、前綴 ${prefix.size} 組\n`);

(async () => {
  const { data, error } = await supabase
    .from('reports')
    .select('id,question_text,roc_year,session,number,message,created_at')
    .eq('status', 'pending').limit(2000);
  if (error) { console.error(error.message); process.exitCode = 1; return; }

  const buckets = { found: [], moved: [], edited: [], lost: [], notext: [] };
  for (const r of data) {
    if (!r.question_text) { buckets.notext.push(r); continue; }
    const n = norm(r.question_text);
    const hit = exact.get(n);
    if (hit) {
      // 完全比對命中：位置對不對得上回報寫的年份題號？
      const same = hit.where === `${r.roc_year}${r.session} #${r.number}`;
      buckets[same ? 'found' : 'moved'].push({ r, hit });
      continue;
    }
    const cands = prefix.get(n.slice(0, 20)) || [];
    if (cands.length) { buckets.edited.push({ r, hit: cands[0] }); continue; }
    buckets.lost.push(r);
  }

  console.log('=== 待處理回報 ' + data.length + ' 筆的去向 ===');
  console.log(`  題還在原位、題幹完全相同        ${buckets.found.length}`);
  console.log(`  題還在，但年份/題號對不上(位移)  ${buckets.moved.length}`);
  console.log(`  題還在原位，但題幹被改過        ${buckets.edited.length}`);
  console.log(`  ⚠️ 整個題庫都找不到（疑似遺失）  ${buckets.lost.length}`);
  console.log(`  回報沒存題幹                    ${buckets.notext.length}`);

  const show = (name, arr, n = 5) => {
    if (!arr.length) return;
    console.log(`\n─── ${name} 樣本 ───`);
    for (const x of arr.slice(0, n)) {
      const r = x.r || x;
      console.log(`  [${String(r.created_at).slice(0, 10)}] ${r.roc_year}${r.session} #${r.number} — ${String(r.message || '(未填)').replace(/\n/g, ' ').slice(0, 40)}`);
      console.log(`     回報題幹: ${String(r.question_text).replace(/\n/g, ' ').slice(0, 55)}`);
      if (x.hit) console.log(`     現在位置: [${x.hit.exam}] ${x.hit.where}`);
    }
  };
  show('位移', buckets.moved);
  show('題幹被改過', buckets.edited);
  show('疑似遺失', buckets.lost, 8);

  fs.writeFileSync(path.join(DIR, '_tmp', 'lost-reports.json'),
    JSON.stringify(buckets.lost, null, 2), 'utf8');
  console.log('\n疑似遺失清單已寫出 _tmp/lost-reports.json');

  // 「題還在原位、題幹完全相同」= 回報後完全沒動過，這批最需要人看
  fs.writeFileSync(path.join(DIR, '_tmp', 'untouched-reports.json'),
    JSON.stringify(buckets.found.map(x => ({ ...x.r, loc: x.hit })), null, 2), 'utf8');

  const classify = (m) => {
    m = String(m || '');
    if (/答案|應為|應該是|給分|選錯/.test(m)) return '答案爭議';
    if (/圖|照片|影片/.test(m)) return '缺圖/影片';
    if (/亂碼|問號/.test(m)) return '亂碼';
    if (/選項/.test(m)) return '選項問題';
    if (/題目|題幹|承上/.test(m)) return '題幹問題';
    if (!m.trim()) return '未填說明';
    return '其他';
  };
  const byType = {};
  for (const x of buckets.found) {
    const t = classify(x.r.message);
    (byType[t] = byType[t] || []).push(x);
  }
  console.log('\n=== 「回報後完全沒動過」' + buckets.found.length + ' 筆的類型 ===');
  for (const [k, v] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
    console.log('  ' + k.padEnd(12) + v.length);
  }
  console.log('\n清單已寫出 _tmp/untouched-reports.json');

})();
