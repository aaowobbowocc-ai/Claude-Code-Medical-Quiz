#!/usr/bin/env node
/**
 * 全站抽樣體檢：「我們的第 N 題，在原卷也是第 N 題嗎？」
 *
 * 這是跟 procedure_paper_alignment_audit 的「命中率體檢」**不同的維度**。
 * 命中率問的是「這卷的題是不是真的出自這張卷」；這支問的是「題號有沒有整段位移」。
 * 題號位移的卷，命中率看起來是滿分 —— 內容確實出自這張卷，只是號碼錯了，
 * 所以舊的體檢抓不到。
 *
 * 2026-11-08 發現 doctor1 106100 醫學(一)/(二) 兩科各約 80 題位移
 * （我們的 #21 是原卷 #20、#23 是原卷 #21…），是查「同卷內完全重複」
 * 時順藤摸出來的 —— 位移在接縫處會製造一對重複題，那是唯一露出水面的症狀。
 *
 * ⚠️ **不要用 pdfQuestions 的題號→題幹 Map 判斷對齊**（audit-number-alignment.js
 *    的抬頭就警告過）：它在部分版型會把題號切錯，好題會被誤判成位移。
 *    這裡用 pdfText 的閱讀順序：在扁平文字裡找到我們的題幹，
 *    再看它前面最近的那串數字是不是 N。
 *
 * ⚠️ 頁首會黏在題號前面（「頁次：6－3」→「...63」），所以取「結尾那串數字」
 *    並允許它**以**題號結尾（63 以 3 結尾也算對上 #3），寧可放過不要錯殺。
 *
 * 每卷抽樣（預設 12 題，散佈全卷），只回報「大部分對不上」的卷。
 *
 *   node scripts/audit-number-shift.js [--exam doctor1] [--sample 12]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { pdfText } = require('./lib/moex-pdf-parse');

const BK = path.join(__dirname, '..');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const only = arg('exam');
const SAMPLE = +(arg('sample') || 12);
/** 學測／分科不是考選部的卷 */
const SKIP = new Set(['gsat', 'ast', 'driver-car', 'driver-moto']);
const flat = s => String(s).replace(/\s+/g, '');

(async () => {
  const bad = [];
  let papers = 0, skipped = 0;
  for (const f of fs.readdirSync(BK).filter(n => /^questions.*\.json$/.test(n))) {
    // 醫師一階是 questions.json 無後綴，用 questions-* 的 glob 會整個漏掉
    const exam = f === 'questions.json' ? 'doctor1' : f.replace(/^questions-/, '').replace(/\.json$/, '');
    if (only && exam !== only) continue;
    if (SKIP.has(exam)) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')); } catch { continue; }
    const arr = Array.isArray(j) ? j : j.questions;
    if (!Array.isArray(arr)) continue;

    const byPaper = {};
    for (const q of arr) {
      if (!q || !q.exam_code || q.incomplete) continue;
      (byPaper[`${q.exam_code}|${q.subject}`] = byPaper[`${q.exam_code}|${q.subject}`] || []).push(q);
    }
    for (const key of Object.keys(byPaper)) {
      const items = byPaper[key].sort((a, b) => a.number - b.number);
      if (items.length < 20) continue;
      const [code, ...rest] = key.split('|');
      const subject = rest.join('|');
      papers++;
      let txt;
      try {
        const p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items });
        if (!p) { skipped++; continue; }
        const buf = await fetchSheet('Q', code, p.c, p.s);
        if (!buf) { skipped++; continue; }
        txt = flat(await pdfText(buf));
      } catch { skipped++; continue; }

      const step = Math.max(1, Math.floor(items.length / SAMPLE));
      let ok = 0, miss = 0, nf = 0;
      const egs = [];
      for (let i = 0; i < items.length; i += step) {
        const q = items[i];
        const probe = flat(q.question).slice(0, 22);
        if (probe.length < 12) { nf++; continue; }
        const at = txt.indexOf(probe);
        if (at < 0) { nf++; continue; }
        const m = txt.slice(Math.max(0, at - 14), at).match(/(\d{1,3})[.．、]?$/);
        if (!m) { nf++; continue; }
        // 頁首黏在前面時數字會變長，允許「以題號結尾」
        if (m[1] === String(q.number) || m[1].endsWith(String(q.number))) ok++;
        else { miss++; if (egs.length < 4) egs.push(`#${q.number}→${m[1]}`); }
      }
      const judged = ok + miss;
      if (judged >= 6 && miss / judged > 0.5) {
        bad.push({ exam, code, subject, n: items.length, ok, miss, nf, egs });
        console.log(`⚠️ ${exam} ${code} ${subject}  本地 ${items.length} 題｜抽樣對上 ${ok} 不符 ${miss}｜${egs.join(' ')}`);
      }
    }
  }
  console.log(`\n檢查 ${papers} 卷（${skipped} 卷拿不到原卷）｜**題號位移** ${bad.length} 卷`);
  fs.mkdirSync(path.join(BK, '_tmp'), { recursive: true });
  fs.writeFileSync(path.join(BK, '_tmp', 'number-shift.json'), JSON.stringify(bad, null, 1), 'utf8');
  if (bad.length) {
    const byExam = {};
    bad.forEach(r => (byExam[r.exam] = (byExam[r.exam] || 0) + 1));
    console.log('依考試:', Object.entries(byExam).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  '));
  }
})().catch(e => { console.error(e.stack); process.exit(1); });
