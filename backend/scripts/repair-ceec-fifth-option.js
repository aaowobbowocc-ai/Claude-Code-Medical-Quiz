#!/usr/bin/env node
/**
 * 學測／分科是五個選項（A~E），但 scrape-ceec.js 只認 (A)~(D)，
 * 第五個選項整段被留在 D 裡面：
 *   D: "丁 (E) 戊"                                   ← 選項 D 變兩個選項黏在一起
 *   D: "磁場…甲＞乙 (E) 磁場…甲＞乙 圖1 甲 乙 H 圖2 B 乙 甲 111 年分科 第 2 頁 …"
 * 於是使用者看到的 D 是錯的，而且根本沒有 E 可選。
 *
 * 這支把 D 從第一個 "(E)" 切開，後段補成選項 E，並把卷面殘渣
 * （頁碼、圖號、節次標題）從 E 的尾巴剪掉——**只認明確標記**，
 * 其他一律留著（切壞好選項比少修還糟，見 procedure_health_report_rules）。
 *
 * 詞彙選填題（選項一路排到 (F)(G)…(J)）不在處理範圍，跳過。
 *
 *   node scripts/repair-ceec-fifth-option.js            # dry-run
 *   node scripts/repair-ceec-fifth-option.js --apply
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./lib/atomic-write');
const { cleanTail } = require('./lib/ceec-tail');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const FILES = ['questions-ast.json', 'questions-gsat.json'];

// 殘渣清單與 cleanTail 搬到 lib/ceec-tail.js，repair-ceec-missing-fifth.js 共用同一份。
let total = 0, skipped = 0;
for (const f of FILES) {
  const p = path.join(BK, f);
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const arr = data.questions || data;
  let n = 0;
  for (const q of arr) {
    const d = String((q.options || {}).D || '');
    const i = d.search(/\(\s*E\s*\)/);
    if (i < 0) continue;
    // 詞彙選填：選項排到 F 以後，切法完全不同，不碰
    if (/\(\s*[F-J]\s*\)/.test(d)) { skipped++; continue; }
    if (q.options.E) { skipped++; continue; }
    const head = cleanTail(d.slice(0, i));
    const tail = cleanTail(d.slice(i).replace(/^\(\s*E\s*\)\s*/, ''));
    if (!head || !tail) { skipped++; continue; }
    if (n < 6) {
      console.log(`  ${f.slice(10, -5)} ${q.roc_year} ${q.subject} #${q.number} 答${q.answer}`);
      console.log(`    舊D: ${JSON.stringify(d.slice(0, 90))}`);
      console.log(`    新D: ${JSON.stringify(head.slice(0, 60))}`);
      console.log(`    新E: ${JSON.stringify(tail.slice(0, 60))}`);
    }
    if (APPLY) { q.options.D = head; q.options.E = tail; }
    n++; total++;
  }
  console.log(`${f}: 拆出第五個選項 ${n} 題`);
  if (APPLY && n) atomicWriteJson(p, data);
}
console.log(`\n共 ${total} 題；跳過 ${skipped} 題（詞彙選填或切不出兩段）${APPLY ? '' : '（dry-run）'}`);
