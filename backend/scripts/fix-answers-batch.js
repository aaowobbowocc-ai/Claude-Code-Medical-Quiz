#!/usr/bin/env node
/**
 * 依 _tmp/numbering-check.json 的判定，批次以考選部標準答案卷覆寫答案。
 *
 * 四道防呆（全部通過才寫）：
 *   1. 判定必須是「題號對得上→答案有問題」（逐題號比題幹 ≥90%）
 *   2. 題幹命中率 ≥ 0.9
 *   3. 答案卷配對數 = 題數（版型沒解析乾淨就不寫）
 *   4. 多重答案（"A,B"）與官方更正卷的題目不動，只補 disputed 標記
 *
 *   node scripts/fix-answers-batch.js [--exam vet] [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { pdfText, parseCorrections } = require('./lib/moex-pdf-parse');
const { sheetMap } = require('./lib/moex-answer-geo');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];
const checks = JSON.parse(fs.readFileSync(path.join(BK, '_tmp', 'numbering-check.json'), 'utf8'))
  .filter(r => r.verdict === '題號對得上→答案有問題')
  .filter(r => !only || r.exam === only);

const FILE = exam => exam === 'doctor1' ? 'questions.json' : `questions-${exam}.json`;
const banks = {};
const load = f => banks[f] || (banks[f] = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')));

(async () => {
  let tChanged = 0, tSame = 0, tSkip = 0, nPapers = 0, skipped = [];
  const touched = new Set();
  for (const r of checks) {
    const f = FILE(r.exam);
    const j = load(f); const arr = Array.isArray(j) ? j : j.questions;
    const items = arr.filter(q => q.exam_code === r.code && q.subject === r.subject);
    if (!items.length) { skipped.push(r.key + ' 題庫無此卷'); continue; }
    let p;
    try { p = await resolvePaper({ exam: r.exam, code: r.code, subject: r.subject, year: String(r.code).slice(0, 3), items }); }
    catch (e) { skipped.push(r.key + ' resolve 失敗'); continue; }
    if (!p) { skipped.push(r.key + ' 對不到官方卷'); continue; }
    const stemHit = p.hitRate != null ? p.hitRate : 1;
    if (stemHit < 0.9) { skipped.push(`${r.key} 題幹命中率 ${stemHit}`); continue; }
    let sm;
    try { sm = await sheetMap(r.code, p.c, p.s, items.length); } catch (e) { skipped.push(r.key + ' 答案卷解析失敗'); continue; }
    if (sm.map.size !== items.length) { skipped.push(`${r.key} 答案卷配對 ${sm.map.size}/${items.length}`); continue; }
    let corr = {};
    try { corr = parseCorrections(await pdfText(await fetchSheet('M', r.code, p.c, p.s))); } catch (_) {}
    let changed = 0, same = 0, skip = 0;
    for (const it of items) {
      const off = sm.map.get(+it.number); if (!off) continue;
      if (String(it.answer).includes(',')) { skip++; continue; }
      if (corr[String(it.number)]) { skip++; if (!it.disputed) it.disputed = true; continue; }
      if (it.answer === off) { same++; continue; }
      if (APPLY) it.answer = off;
      changed++;
    }
    nPapers++; tChanged += changed; tSame += same; tSkip += skip; touched.add(f);
    console.log(`${r.exam} ${r.code} ${r.subject}: 原正確 ${same}, ${APPLY ? '已改' : '待改'} ${changed}, 保留 ${skip}`);
  }
  if (APPLY) for (const f of touched) fs.writeFileSync(path.join(BK, f), JSON.stringify(banks[f], null, 2), 'utf8');
  console.log(`\n${nPapers} 卷 | 原本正確 ${tSame} | ${APPLY ? '已修正' : '待修正'} ${tChanged} | 多重答案/官方更正保留 ${tSkip}`);
  if (skipped.length) { console.log('跳過', skipped.length, '卷:'); skipped.slice(0, 20).forEach(s => console.log('  -', s)); }
})().catch(e => { console.error(e.stack); process.exit(1); });
