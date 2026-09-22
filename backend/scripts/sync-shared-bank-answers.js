#!/usr/bin/env node
/**
 * 把共用題庫（shared-banks/）裡「從主題庫複製過去」的題，答案同步回主題庫的版本。
 *
 * 為什麼可以信主題庫：主題庫的答案在 2026-09-19 已整批對過考選部標準答案卷
 * （[[procedure_answer_audit_sitewide]]，修掉 2,421 題），共用題庫那一份卻是
 * 當初爬蟲用「照閱讀順序配字母」抓的，**從第 12 題起整批位移一格**
 * （關務 115 英文實測：#1–11 相同、#12 之後全錯；主題庫逐題與官方相符）。
 *
 * 配對一定要同時用「題號 + 題幹」：光比題幹會撞名——英文閱讀測驗好幾題的題幹都是
 * 「According to the passage, which of the following…」，只比題幹會把 #25 配到 #24。
 *
 *   node scripts/sync-shared-bank-answers.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const { skeleton } = require('./lib/moex-normalize');
const { atomicWriteJson } = require('./lib/atomic-write');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
// 共用題庫的 source_exam_code → 主題庫檔案
const SOURCES = { police: 'questions-police.json', customs: 'questions-customs.json', police4: 'questions-police4.json' };

const main = {};
for (const [src, f] of Object.entries(SOURCES)) {
  const p = path.join(BK, f);
  if (!fs.existsSync(p)) continue;
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const arr = Array.isArray(j) ? j : j.questions;
  const idx = new Map();
  for (const q of arr) {
    const year = String(q.exam_code || '').slice(0, 3);
    const k = `${year}|${q.number}|${skeleton(q.question).slice(0, 24)}`;
    if (k.length > 12 && !idx.has(k)) idx.set(k, q);
  }
  main[src] = idx;
  console.log(`${src} 主題庫索引 ${idx.size} 題`);
}

const diffs = [], byBank = {};
let tot = 0, notFound = 0;
const banks = {};
for (const f of fs.readdirSync(path.join(BK, 'shared-banks')).filter(x => /\.json$/.test(x))) {
  const p = path.join(BK, 'shared-banks', f);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const arr = Array.isArray(raw) ? raw : raw.questions;
  if (!arr) continue;
  banks[p] = { raw, dirty: false };
  for (const q of arr) {
    const idx = main[q.source_exam_code];
    if (!idx) continue;
    tot++;
    const k = `${q.roc_year}|${q.number}|${skeleton(q.question).slice(0, 24)}`;
    const m = idx.get(k);
    if (!m) { notFound++; continue; }
    if (m.answer === q.answer) continue;
    diffs.push({ bank: f, id: q.id, year: q.roc_year, n: q.number, old: q.answer, neu: m.answer,
      q: String(q.question).replace(/\s+/g, ' ').slice(0, 42) });
    byBank[f] = (byBank[f] || 0) + 1;
    if (APPLY) { q.answer = m.answer; banks[p].dirty = true; }
  }
}

console.log(`\n可比對 ${tot} 題，主題庫配對不到 ${notFound} 題，答案不同 ${diffs.length} 題`);
Object.entries(byBank).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k} ${v}`));
fs.writeFileSync(path.join(BK, '_tmp', 'shared-sync-plan.json'), JSON.stringify(diffs, null, 1), 'utf8');
diffs.slice(0, 20).forEach(d => console.log(`  ${d.bank} ${d.year} #${d.n} ${d.old}→${d.neu} | ${d.q}`));
if (APPLY) {
  let n = 0;
  for (const p of Object.keys(banks)) if (banks[p].dirty) { atomicWriteJson(p, banks[p].raw); n++; }
  console.log(`\n已寫回 ${n} 個共用題庫`);
} else console.log('\n(試跑；加 --apply 才寫入)');
