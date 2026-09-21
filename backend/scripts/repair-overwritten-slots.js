#!/usr/bin/env node
/**
 * 修「一題被寫進另一題的位置、卻留著原位置的答案」——使用者會照著背錯答案，
 * 所以這型優先於一般的題幹破損。
 *
 * 三筆都已逐卷對過原卷與標準答案卷（2026-09-21）：
 *   medlab 100140 #29  被 #30（肺順應性）蓋掉；官方 #29=B，我們存的也是 B → 只換題幹選項
 *   police  109070 #40 被 #50（"key" 字義題）蓋掉；官方 #40=D，我們存的也是 D
 *   tcm1    102110 #60 被 #5（溫脾湯）蓋掉；官方 #60=C，我們存的也是 C，
 *                      但原卷 #60 的選項是藥材圖，文字層取不到 → 留空並標 image_options
 *
 * 三筆的答案字母都恰好是對的：被蓋掉的只有題幹與選項。
 *
 *   node scripts/repair-overwritten-slots.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./lib/atomic-write');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');

const FIXES = [
  { file: 'questions-medlab.json', id: '100140029', expectAns: 'B',
    question: '體重70 公斤35 歲正常成人，休息時每分鐘氧氣消耗量約為：',
    options: { A: '150 mL', B: '250 mL', C: '350 mL', D: '450 mL' } },
  { file: 'questions-police.json', id: 580, expectAns: 'D',
    question: "Almost one thousand students will _____ at the university's gymnasium to attend the graduation commencement in June.",
    options: { A: 'certify', B: 'chatter', C: 'coincide', D: 'converge' } },
  { file: 'questions-tcm1.json', id: '102110_0202_60', expectAns: 'C',
    question: '下列何藥為活血調經之要藥，並為治頭痛之要藥？',
    options: { A: '', B: '', C: '', D: '' }, incomplete: 'image_options' },
];

let n = 0;
const banks = {};
for (const fx of FIXES) {
  const p = path.join(BK, fx.file);
  if (!banks[fx.file]) { const j = JSON.parse(fs.readFileSync(p, 'utf8')); banks[fx.file] = { raw: j, arr: Array.isArray(j) ? j : j.questions }; }
  const q = banks[fx.file].arr.find(x => String(x.id) === String(fx.id));
  if (!q) { console.log(`✗ ${fx.file} id=${fx.id} 找不到`); continue; }
  // 答案字母必須與稽核當下一致，否則代表資料又動過，停手
  if (q.answer !== fx.expectAns) { console.log(`✗ ${fx.file} id=${fx.id} 答案已變成 ${q.answer}（預期 ${fx.expectAns}），不動`); continue; }
  console.log(`✓ ${fx.file} #${q.number}\n    舊: ${String(q.question).replace(/\s+/g, ' ').slice(0, 60)}\n    新: ${fx.question.slice(0, 70)}`);
  if (APPLY) {
    q.question = fx.question;
    q.options = fx.options;
    if (fx.incomplete) q.incomplete = fx.incomplete; else delete q.incomplete;
  }
  n++;
}
if (APPLY) { for (const f of Object.keys(banks)) atomicWriteJson(path.join(BK, f), banks[f].raw); console.log(`\n已修 ${n} 題，寫回 ${Object.keys(banks).length} 個檔`); }
else console.log(`\n${n} 題可修（試跑；加 --apply 才寫入）`);
