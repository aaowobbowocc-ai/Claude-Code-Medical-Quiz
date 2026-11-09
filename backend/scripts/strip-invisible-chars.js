#!/usr/bin/env node
/**
 * 清掉題庫裡的「看不見的字元」。
 *
 * 2026-11-09 從 nursing 105030 #50 追出來的一整類壞法：
 * 題源的選項標記 ⒶⒷⒸⒹ（PUA U+E181…）在某一手轉碼時被當成 cp1252 解過一次，
 * 變成 U+0081/U+0082/U+0083/U+0084 這些 **C1 控制字元**，黏在每個選項的最前面。
 * 它們在畫面上不顯示，所以肉眼與既有的 PUA 檢查都抓不到，但是會讓
 * 「用題幹文字去原卷定位」「比對兩題是否重複」這類字串比對**靜默失效**。
 * 全站 794 題中鏢（郵政 756、radiology 13、driver-car 4…）。
 *
 * 處理方式：
 *   - C0 控制字元（保留 \t \n \r）、DEL、C1 控制字元、零寬字、BOM → 刪除。
 *     它們本來就不顯示，刪掉在畫面上零變化。
 *   - 軟連字號 U+00AD → 減號。這個會顯示（peri­implantitis 其實是 peri-implantitis）。
 *
 * ⚠️ 不碰 PUA（U+E000–U+F8FF）。那是另一條線，要查字形對照表
 *    （scripts/data/pua-glyph-map.json），不能一律刪。
 *
 *   node scripts/strip-invisible-chars.js          # 試跑
 *   node scripts/strip-invisible-chars.js --apply
 */
const fs = require('fs');
const path = require('path');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const DROP = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‍⁠﻿]/g;
const FIELDS = ['question', 'explanation'];

const clean = s => String(s).replace(DROP, '').replace(/­/g, '-');

let totQ = 0, totCh = 0;
const perExam = {};
const samples = [];

for (const f of fs.readdirSync(BK).filter(n => /^questions(-.*)?\.json$/.test(n) && !/\.bak/.test(n))) {
  const p = path.join(BK, f);
  const rawText = fs.readFileSync(p, 'utf8');
  const j = JSON.parse(rawText);
  const arr = Array.isArray(j) ? j : j.questions;
  if (!Array.isArray(arr)) continue;
  const exam = f === 'questions.json' ? 'doctor1' : f.replace(/^questions-/, '').replace(/\.json$/, '');
  let fileQ = 0, fileCh = 0;

  for (const q of arr) {
    let hit = 0;
    for (const k of FIELDS) {
      if (typeof q[k] !== 'string') continue;
      const c = clean(q[k]);
      if (c === q[k]) continue;
      hit += [...q[k]].length - [...c].length + (q[k].match(/­/g) || []).length;
      if (samples.length < 6) samples.push(exam + ' ' + (q.exam_code || '') + ' #' + q.number + ' ' + k + ': ' + JSON.stringify(q[k].slice(0, 46)) + ' → ' + JSON.stringify(c.slice(0, 46)));
      if (APPLY) q[k] = c;
    }
    for (const g of ['options', 'option_images']) {
      if (!q[g] || typeof q[g] !== 'object') continue;
      for (const k of Object.keys(q[g])) {
        if (typeof q[g][k] !== 'string') continue;
        const c = clean(q[g][k]);
        if (c === q[g][k]) continue;
        hit += [...q[g][k]].length - [...c].length + (q[g][k].match(/­/g) || []).length;
        if (APPLY) q[g][k] = c;
      }
    }
    if (hit) { fileQ++; fileCh += hit; }
  }

  if (!fileQ) continue;
  perExam[exam] = fileQ;
  totQ += fileQ; totCh += fileCh;
  // 保留原本的檔尾換行，否則每個題庫檔都會多一筆「\ No newline at end of file」的雜訊 diff
  if (APPLY) fs.writeFileSync(p, JSON.stringify(j, null, 2) + (rawText.endsWith('\n') ? '\n' : ''), 'utf8');
}

console.log('範例：');
samples.forEach(s => console.log('  ' + s));
console.log('\n受影響題數：' + totQ + '（共 ' + totCh + ' 個字元）');
Object.entries(perExam).sort((a, b) => b[1] - a[1]).forEach(([e, n]) => console.log('  ' + String(n).padStart(5) + '  ' + e));
if (!APPLY) console.log('\n(試跑；加 --apply 才寫入)');
