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

/*
 * 備註的解析**只有一份**，在 fetch-session-corrections.js。
 * 原本這裡自己寫了一份，兩份判斷不一樣：
 *   「第65題除未作答者不給分外，其餘均給分」
 * 這裡的版本要求出現「一律給分」或字母才算數，於是這一筆被當成「更正卷沒提這一題」，
 * 另一支卻正確地當成送分 —— 同一份 PDF 兩個答案，稽核就失去意義。
 */
const { parseRemark: parseRemarks } = require('./fetch-session-corrections');

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
      // 「答A、B、C、D給分」＝一律給分，題庫存「送分」。兩邊要用同一套寫法比，
      // 否則 26 筆正確的資料會被報成不符。
      const opts = Object.keys(q.options || {});
      const norm = (want !== '送分' && opts.length && want.split(',').length === opts.length
        && opts.every(k => want.split(',').includes(k))) ? '送分' : want;
      const cur = String(q.answer || '');
      if (cur !== norm) bad.push(`△ ${k} #${q.number}  更正卷：${norm}｜題庫 answer=${cur}｜註記「${note.slice(0, 32)}」`);
    }
  }
  console.log(`對過 ${checked} 筆註記｜抓不到更正卷 ${noSheet} 筆\n`);
  bad.forEach(s => console.log(s));
  console.log(`\n有問題 ${bad.length} 筆`);
})();
