#!/usr/bin/env node
/**
 * 拿考選部的更正答案卷，驗題庫裡的 `correction_note` 與 `answer` 對不對。
 *
 * 為什麼要驗：2026-11-20 修「官方給兩個答案」時發現註記本身就不可信 ——
 *   · 牙醫二階 113090 卷二 #54 掛著「第79題更正為 B,D」（註記的題號不是自己的題號）
 *   · 藥師一階 113020 #32「鴉片過量最適合立即注射？」答案是 naloxone，
 *     卻掛著「第32題更正為 A,D」（A=buprenorphine、D=methylnaltrexone），
 *     而那一卷的更正卷根本沒提 #32，提的是 #38「答Ｂ或Ｄ均給分」
 *   · 藥師一階 111020 #38、112100 #29 同型（112100 卷一甚至沒有更正卷）
 * 註記錯了會連帶把答案改錯，所以每一筆都要回去對原卷。
 *
 * 更正卷的備註長這樣（在整份 PDF 的最後）：
 *   「第19題答Ｂ或Ｃ或BC者均給分，第43題答Ｂ或Ｄ或BD者均給分」
 *   「第6題，答Ｂ或Ｄ或BD者均給分。 第45題，答Ｃ給分。」
 *   「第12題答Ａ或Ｂ或Ｄ或AB或AD或BD或ABD者均給分」
 *
 *   node scripts/audit-correction-notes.js [--exam=pharma1] [--json]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet, pdfText } = require('./lib/moex-paper-resolve');

const BK = path.join(__dirname, '..');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const onlyExam = arg('exam');
const fileOf = e => (e === 'doctor1' ? 'questions.json' : `questions-${e}.json`);

const FW = { 'Ａ': 'A', 'Ｂ': 'B', 'Ｃ': 'C', 'Ｄ': 'D', 'Ｅ': 'E' };
const half = s => String(s).replace(/[ＡＢＣＤＥ]/g, c => FW[c]);

/** 從備註文字抓出「第N題 → 哪些答案給分」。 */
function parseRemarks(text) {
  const out = {};
  const t = half(String(text || '')).replace(/\s+/g, '');
  // 「第N題答B或D或BD者均給分」「第N題，答C給分」「第N題一律給分」
  const re = /第(\d{1,3})題[，,]?([^第]{0,120}?給分)/g;
  let m;
  while ((m = re.exec(t))) {
    const n = +m[1];
    const body = m[2];
    if (/一律給分|均給分.*送分|送分/.test(body) && !/[A-E]/.test(body)) { out[n] = '送分'; continue; }
    // 單一字母的組合（BD、ABD）不另外算，字母集合就是答案集合
    const letters = [...new Set((body.match(/[A-E]/g) || []))].sort();
    if (letters.length) out[n] = letters.join(',');
  }
  return out;
}

(async () => {
  const groups = {};
  for (const f of fs.readdirSync(BK).filter(x => /^questions(-[a-z0-9-]*)?\.json$/.test(x) && !/\.bak/.test(x))) {
    const exam = f === 'questions.json' ? 'doctor1' : f.replace(/^questions-/, '').replace(/\.json$/, '');
    if (onlyExam && exam !== onlyExam) continue;
    const arr = (j => Array.isArray(j) ? j : j.questions)(JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')));
    for (const q of arr) {
      if (!q.correction_note) continue;
      const k = `${exam}|${q.exam_code}|${q.subject}`;
      (groups[k] = groups[k] || []).push(q);
    }
  }
  const bad = [];
  let checked = 0, noSheet = 0;
  for (const k of Object.keys(groups).sort()) {
    const [exam, code, subject] = k.split('|');
    const items = groups[k];
    let remarks = null;
    try {
      const all = (j => Array.isArray(j) ? j : j.questions)(JSON.parse(fs.readFileSync(path.join(BK, fileOf(exam)), 'utf8')))
        .filter(q => String(q.exam_code) === code && q.subject === subject);
      const p = await resolvePaper({ exam, code, year: String(all[0].roc_year), subject, items: all });
      if (p) {
        const b = await fetchSheet('M', code, p.c, p.s);
        if (b) remarks = parseRemarks(await pdfText(b));
      }
    } catch { /* 抓不到就當沒有更正卷 */ }
    if (!remarks) { noSheet += items.length; bad.push(`? ${k}  抓不到更正卷，${items.length} 筆註記無從驗證`); continue; }
    for (const q of items) {
      checked++;
      const want = remarks[+q.number];
      const note = String(q.correction_note);
      if (!want) { bad.push(`✗ ${k} #${q.number}  更正卷沒提這一題，註記卻說「${note.slice(0, 32)}」`); continue; }
      const cur = String(q.answer || '');
      if (cur !== want) bad.push(`△ ${k} #${q.number}  更正卷：${want}｜題庫 answer=${cur}｜註記「${note.slice(0, 32)}」`);
    }
  }
  console.log(`對過 ${checked} 筆註記｜抓不到更正卷 ${noSheet} 筆\n`);
  bad.forEach(s => console.log(s));
  console.log(`\n有問題 ${bad.length} 筆`);
})();
