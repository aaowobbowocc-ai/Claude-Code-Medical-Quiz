#!/usr/bin/env node
/**
 * 把題庫文字正規化成 Unicode NFC。
 *
 * 問題：考選部 PDF 夾帶大量「CJK 相容表意文字」（U+F900–U+FAFF），例如 U+F92D
 * 跟正常的「來」U+4F86 長得一模一樣，但碼位不同。後果：
 *   - 使用者搜尋「來」搜不到這些題
 *   - 任何字串比對（重複題偵測、答案比對、爬蟲補題的題幹比對）都會漏掉
 *   - 同一題在不同批次抓取下可能一個是相容字、一個是正常字，看起來一樣卻不相等
 *
 * NFC 對這些字有標準的單例正規對應，正規化後字形完全不變，只是碼位統一。
 * 全形/半形不受影響（那是 NFKC 才會動，我們刻意不用 NFKC，以保留原卷排版）。
 *
 * 用法：
 *   node scripts/normalize-nfc.js           # dry-run，統計會改幾個字
 *   node scripts/normalize-nfc.js --apply
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
// 走訪所有字串欄位（早期只挑 question/options/explanation，結果 subject_name 之外
// 還有別的欄位殘留相容字）

// 只統計相容表意文字，其他 NFC 差異（極少）一併正規化但不另外報數
const COMPAT = /[豈-﫿]/g;

let totalChars = 0, totalFields = 0, totalQ = 0;
const per = {};

// shared-banks 也要掃：它是主題庫的快照，不跟著正規化的話，
// 同步腳本用題幹配對時會對不上（2026-11-18 實測殘留 270 個相容字）。
const SHARED = path.join(DIR, 'shared-banks');
const targets = fs.readdirSync(DIR)
  .filter(f => /^questions(-.*)?\.json$/.test(f) && !/\.bak/.test(f))
  .map(f => ({ file: f, full: path.join(DIR, f) }));
if (fs.existsSync(SHARED)) {
  for (const f of fs.readdirSync(SHARED)) {
    if (f.endsWith('.json')) targets.push({ file: 'shared-banks/' + f, full: path.join(SHARED, f) });
  }
}

for (const { file, full } of targets) {
  let json;
  try { json = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
  const arr = Array.isArray(json) ? json : json.questions;
  if (!arr) continue;

  let chars = 0, fields = 0, qs = 0;
  const walk = (obj) => {
    let hit = 0;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string') {
        const n = v.normalize('NFC');
        if (n !== v) { chars += (v.match(COMPAT) || []).length; fields++; hit++; if (APPLY) obj[k] = n; }
      } else if (v && typeof v === 'object') {
        hit += walk(v);
      }
    }
    return hit;
  };
  for (const q of arr) {
    if (walk(q)) qs++;
  }

  if (qs) {
    per[file.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '')] = { qs, chars };
    totalQ += qs; totalFields += fields; totalChars += chars;
    if (APPLY) fs.writeFileSync(full, JSON.stringify(json, null, 2), 'utf8');
  }
}

console.log(`相容表意文字 ${totalChars} 個，影響 ${totalQ} 題 / ${totalFields} 個欄位\n`);
for (const [k, v] of Object.entries(per).sort((a, b) => b[1].chars - a[1].chars)) {
  console.log(`  ${k.padEnd(24)} ${String(v.qs).padStart(5)} 題  ${String(v.chars).padStart(6)} 字`);
}
console.log(APPLY ? '\n✅ 已寫入' : '\n(dry-run，加 --apply 才會寫入)');
