#!/usr/bin/env node
/**
 * 修「題號被切掉一位數，害真正的那一題被蓋掉」的槽位。
 *
 * 2026-11-02 使用者回報：律師 105 年綜合法學二「題目跟選項錯置，
 * 題目開頭有意義不明的 0，或是題目和選項不搭邊」。
 *
 * 實際狀況：原卷的題號行是「30.」，解析時只吃掉「3」當題號，剩下的「0」
 * 漏進題幹，於是**第 30 題的整筆內容（題幹、選項、答案）被寫進第 3 題的槽位**，
 * 真正的第 3 題就這樣消失了。律師 105110 四科各中 4~5 題。
 *
 *   我們的 #3 ：「0 雲林縣政府經古蹟…」   ← 其實是 #30
 *   原卷的 #3 ：「承上題，甲政黨立法委員對於乙政黨總統極度不滿…」
 *
 * **判準不是「題幹開頭有數字」**，那會掃到正常的「0.5 公克…」。
 * 要三件事同時成立才算：
 *   1. 題幹開頭是一個數字 d 後面接空白
 *   2. 同一卷裡存在第 (n*10 + d) 題
 *   3. 去掉開頭那個 d 之後，兩題的題幹逐字相同
 * 也就是說，得先證明「這一格裝的是另一格的內容」才動它。
 *
 * 重建時題幹、選項、答案**全部**換成原卷的 —— 這一格裡沒有任何東西是對的，
 * 舊答案是照被複製的那題存的，留著只會變成「正確的題目配錯誤的答案」。
 *
 *   node scripts/repair-leading-digit-slots.js [--exam lawyer1] [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { pdfQuestions } = require('./lib/moex-pdf-parse');
const { markerOptions } = require('./lib/moex-marker-options');
const { parseAnswerSheet } = require('./lib/moex-answer-sheet');
const { normText } = require('./lib/moex-normalize');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const ei = process.argv.indexOf('--exam');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1]
  || (ei > 0 ? process.argv[ei + 1] : null) || null;

const LEAD = /^\s*(\d)\s+/;
const key = t => normText(String(t || '')).replace(/\s/g, '');
const optsOf = o => ['A', 'B', 'C', 'D'].map(k => String((o || {})[k] || '').trim());
const clean = a => a.length === 4 && a.every(t => t) && new Set(a.map(normText)).size === 4;

/** 掃出「這一格裝的是另一格的內容」的槽位。 */
function victims() {
  const out = [];
  for (const f of fs.readdirSync(BK).filter(n => /^questions.*\.json$/.test(n))) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')); } catch { continue; }
    const arr = Array.isArray(j) ? j : j.questions;
    if (!Array.isArray(arr)) continue;
    // 醫師一階是 questions.json 無後綴，用 questions-* 的 glob 會整個漏掉
    const exam = f === 'questions.json' ? 'doctor1' : f.replace(/^questions-/, '').replace(/\.json$/, '');
    if (only && exam !== only) continue;
    const byPaper = {};
    for (const q of arr) {
      if (!q || !q.exam_code) continue;
      (byPaper[`${q.exam_code}|${q.subject}`] = byPaper[`${q.exam_code}|${q.subject}`] || []).push(q);
    }
    for (const pk of Object.keys(byPaper)) {
      const list = byPaper[pk];
      const byNum = new Map(list.map(q => [Number(q.number), q]));
      for (const q of list) {
        const m = LEAD.exec(String(q.question || ''));
        if (!m) continue;
        const n = Number(q.number), d = Number(m[1]);
        const other = byNum.get(n * 10 + d);
        if (!other) continue;
        if (key(String(q.question).replace(LEAD, '')) !== key(other.question)) continue;
        const [code, ...rest] = pk.split('|');
        out.push({ file: f, exam, code, subject: rest.join('|'), id: q.id, n, copiedFrom: n * 10 + d });
      }
    }
  }
  return out;
}

(async () => {
  const rows = victims();
  const groups = {};
  for (const r of rows) (groups[`${r.exam}|${r.code}|${r.subject}`] = groups[`${r.exam}|${r.code}|${r.subject}`] || []).push(r);
  console.log(`被蓋掉的槽位：${rows.length} 題，分布在 ${Object.keys(groups).length} 卷\n`);

  const banks = {}, plan = [], skip = [];
  for (const gk of Object.keys(groups)) {
    const [exam, code, subject] = gk.split('|');
    const f = groups[gk][0].file;
    if (!banks[f]) { const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')); banks[f] = { raw: j, arr: Array.isArray(j) ? j : j.questions }; }
    const items = banks[f].arr.filter(q => q.exam_code === code && q.subject === subject);
    let src = null, mo = null, ans = {};
    try {
      const p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items });
      if (!p) { groups[gk].forEach(r => skip.push({ ...r, why: '對不到官方卷' })); continue; }
      const buf = await fetchSheet('Q', code, p.c, p.s);
      if (!buf) { groups[gk].forEach(r => skip.push({ ...r, why: '抓不到試題 PDF' })); continue; }
      src = await pdfQuestions(buf);
      try { mo = await markerOptions(buf); } catch { /* 這卷沒有 PUA 標記 */ }
      try { const sb = await fetchSheet('S', code, p.c, p.s); if (sb) ans = await parseAnswerSheet(sb); } catch { /* 下面會擋 */ }
    } catch (e) { groups[gk].forEach(r => skip.push({ ...r, why: '原卷處理失敗: ' + e.message.slice(0, 40) })); continue; }

    for (const r of groups[gk]) {
      const q = banks[f].arr.find(x => String(x.id) === String(r.id));
      const s = src && src.get(r.n);
      if (!q || !s) { skip.push({ ...r, why: '原卷解析不到該題號' }); continue; }
      const stem = String(s.stem || '').replace(/^[\s.．、]+/, '').trim();
      if (stem.length < 10) { skip.push({ ...r, why: '原卷題幹太短' }); continue; }
      // 這一格其實沒壞：題幹本來就以數字開頭（「1 月齡嬰幼兒鼓室圖檢查…」），
      // 只是剛好另一題的題幹等於去掉那個數字之後的字串。原卷與我們一致就別動 ——
      // 硬換成原卷解析出來的選項反而可能帶進 PDF 的排版雜訊。
      if (key(stem) === key(q.question)) { skip.push({ ...r, why: '原卷與現有相同（這格沒壞，誤報）' }); continue; }
      // 這一格原本的內容整筆是錯的，所以絕不沿用現有選項（它們屬於被複製的那題）
      let opts = (s.options || []).map(x => String(x || '').trim());
      if (!clean(opts) && mo) {
        const alt = mo.get(r.n) || mo.get(String(r.n));
        if (alt) opts = optsOf(alt.options);
      }
      if (!clean(opts)) { skip.push({ ...r, why: '原卷選項抽不完整' }); continue; }
      const a = String(ans[r.n] || '').trim();
      if (!/^[A-E](\s*[,、]\s*[A-E])*$/.test(a)) { skip.push({ ...r, why: '取不到官方答案' }); continue; }

      plan.push({ ...r, oldStem: String(q.question).slice(0, 46), newStem: stem.slice(0, 46), oldAns: q.answer, newAns: a });
      if (APPLY) {
        q.question = stem;
        q.options = { A: opts[0], B: opts[1], C: opts[2], D: opts[3] };
        q.answer = a;
        q.explanation = '';
        if (q.incomplete) delete q.incomplete;
      }
    }
  }

  console.log(`可重建 ${plan.length} 題，跳過 ${skip.length} 題\n`);
  for (const r of plan) {
    console.log(`  ✓ ${r.exam} ${r.code} #${r.n}（原本裝的是 #${r.copiedFrom}）答 ${r.oldAns} → ${r.newAns}`);
    console.log(`      舊：${r.oldStem}`);
    console.log(`      新：${r.newStem}`);
  }
  const by = {}; skip.forEach(r => (by[r.why] = (by[r.why] || 0) + 1));
  if (skip.length) { console.log('\n跳過原因:'); Object.entries(by).sort((a, b) => b[1] - a[1]).forEach(([w, n]) => console.log(`  ${n} 題 — ${w}`)); }

  if (APPLY) {
    const files = new Set(plan.map(r => r.file));
    for (const f of files) fs.writeFileSync(path.join(BK, f), JSON.stringify(banks[f].raw, null, 2) + '\n', 'utf8');
    console.log(`\n已寫回 ${files.size} 個題庫檔`);
  } else console.log('\n(試跑；加 --apply 才寫入)');
})().catch(e => { console.error(e.stack); process.exit(1); });
