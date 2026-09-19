#!/usr/bin/env node
/**
 * 依考選部標準答案卷覆寫整卷答案。只在「題幹確定對得上、答案卻大面積不符」時使用。
 *
 * 三道防呆（缺一不可）：
 *   1. 題幹命中率 ≥ 0.9  —— 確定抓的是同一張卷，否則會把別卷答案蓋進來
 *   2. 答案卷配對數 = 題數 —— 少配對到就代表版型沒解析乾淨
 *   3. 多重答案（"A,B"）與更正卷的題目不動 —— 那是官方更正的結果，不是錯誤
 *
 *   node scripts/fix-paper-answers.js --exam pharma1 --subject 卷三 --codes 106020,106100 [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { pdfText, parseCorrections } = require('./lib/moex-pdf-parse');
const { sheetMap } = require('./lib/moex-answer-geo');

const BK = path.join(__dirname, '..');
const arg = k => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : null; };
const APPLY = process.argv.includes('--apply');
const EXAM = arg('exam'), SUBJ = arg('subject'), CODES = (arg('codes') || '').split(',').filter(Boolean);
const FILE = EXAM === 'doctor1' ? 'questions.json' : `questions-${EXAM}.json`;

(async () => {
  const j = JSON.parse(fs.readFileSync(path.join(BK, FILE), 'utf8'));
  const arr = Array.isArray(j) ? j : j.questions;
  let totalChanged = 0;
  for (const code of CODES) {
    const items = arr.filter(q => q.exam_code === code && q.subject === SUBJ).sort((a, b) => +a.number - +b.number);
    if (!items.length) { console.log(code, SUBJ, '→ 題庫無此卷'); continue; }
    const p = await resolvePaper({ exam: EXAM, code, subject: SUBJ, year: String(code).slice(0, 3), items });
    if (!p) { console.log(code, SUBJ, '→ 對不到官方卷，跳過'); continue; }
    const stemHit = p.hitRate != null ? p.hitRate : 1;
    if (stemHit < 0.9) { console.log(code, SUBJ, `→ 題幹命中率僅 ${stemHit}，不敢改答案`); continue; }
    const sm = await sheetMap(code, p.c, p.s, items.length);
    if (sm.map.size !== items.length) { console.log(code, SUBJ, `→ 答案卷只配對到 ${sm.map.size}/${items.length}，跳過`); continue; }
    let corr = {};
    try { corr = parseCorrections(await pdfText(await fetchSheet('M', code, p.c, p.s))); } catch (_) {}
    let changed = 0, skipMulti = 0, skipCorr = 0, same = 0;
    for (const it of items) {
      const off = sm.map.get(+it.number);
      if (!off) continue;
      if (String(it.answer).includes(',')) { skipMulti++; continue; }
      if (corr[String(it.number)]) { skipCorr++; if (!it.disputed) it.disputed = true; continue; }
      if (it.answer === off) { same++; continue; }
      if (APPLY) it.answer = off;
      changed++;
    }
    console.log(`${code} ${SUBJ} (c=${p.c} s=${p.s} 題幹${(100*stemHit).toFixed(0)}%) → 原本正確 ${same}，${APPLY?'已改':'待改'} ${changed}，多重答案保留 ${skipMulti}，官方更正保留 ${skipCorr}`);
    totalChanged += changed;
  }
  if (APPLY) { fs.writeFileSync(path.join(BK, FILE), JSON.stringify(j, null, 2), 'utf8'); console.log('已寫入', FILE); }
  console.log((APPLY ? '合計已修正 ' : '合計待修正 ') + totalChanged + ' 題');
})().catch(e => { console.error(e.stack); process.exit(1); });
