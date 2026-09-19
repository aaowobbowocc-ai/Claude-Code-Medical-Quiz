#!/usr/bin/env node
/**
 * 依官方答案卷更正公職卷既有題目的答案。
 *
 * 先前 fix-answers-batch 用「答案卷配對數 = 題數」當防呆，把這些卷全擋了
 * （我們存 35 題、官方卷 50 題）。但那個條件對「只收測驗題的混合卷」是錯的門檻。
 * 正確門檻是**逐題號比題幹**：對得上就代表題號沒錯位，答案卷可以信。
 *
 *   node scripts/fix-civil-answers.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { pdfText, parseCorrections } = require('./lib/moex-pdf-parse');
const { answerMap } = require('./lib/moex-answer-geo');
const { skeleton } = require('./lib/moex-normalize');
const { paperQuestions } = require('./fill-civil-gaps');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const EXAMS = ['police', 'police4', 'customs'];

(async () => {
  let tChanged = 0, tSame = 0, tSkip = 0, papers = 0;
  for (const exam of EXAMS) {
    const f = `questions-${exam}.json`;
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    const g = {};
    for (const q of arr) { if (!q.exam_code) continue; const k = q.exam_code + '|' + q.subject; (g[k] = g[k] || []).push(q); }
    let touched = false;
    for (const k of Object.keys(g)) {
      const [code, ...rest] = k.split('|'); const subject = rest.join('|');
      const items = g[k];
      let p;
      try { p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items }); } catch (e) { continue; }
      if (!p) continue;
      let qs, am;
      try { qs = await paperQuestions(code, p.c, p.s); am = await answerMap(code, p.c, p.s, Math.max(items.length, qs.size), p.subject); }
      catch (e) { continue; }
      if (!qs.size || !am || !am.map.size) continue;
      let hit = 0, tot = 0;
      for (const it of items) { const s = qs.get(+it.number); if (!s) continue; tot++; if (skeleton(it.question).slice(0, 20) === skeleton(s.stem).slice(0, 20)) hit++; }
      const rate = tot ? hit / tot : 0;
      if (tot < items.length * 0.5 || rate < 0.9) continue;   // 題號對不上就不動
      let corr = {};
      try { corr = parseCorrections(await pdfText(await fetchSheet('M', code, p.c, p.s))); } catch (_) {}
      let changed = 0, same = 0, skip = 0;
      for (const it of items) {
        if (!qs.get(+it.number)) { skip++; continue; }         // 題幹沒對上的個別題不動
        const off = am.map.get(+it.number); if (!off) { skip++; continue; }
        if (String(it.answer).includes(',')) { skip++; continue; }
        if (corr[String(it.number)]) { skip++; if (!it.disputed) it.disputed = true; continue; }
        if (it.answer === off) { same++; continue; }
        if (APPLY) it.answer = off;
        changed++;
      }
      if (changed) { papers++; touched = true; console.log(`${exam} ${code} ${subject}: 題幹對齊 ${(100*rate).toFixed(0)}%，原正確 ${same}，${APPLY ? '已改' : '待改'} ${changed}，保留 ${skip}`); }
      tChanged += changed; tSame += same; tSkip += skip;
    }
    if (APPLY && touched) fs.writeFileSync(path.join(BK, f), JSON.stringify(j, null, 2), 'utf8');
  }
  console.log(`\n${papers} 卷 | 原本正確 ${tSame} | ${APPLY ? '已修正' : '待修正'} ${tChanged} | 保留 ${tSkip}`);
})().catch(e => { console.error(e.stack); process.exit(1); });
