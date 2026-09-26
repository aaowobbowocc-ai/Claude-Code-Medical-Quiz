#!/usr/bin/env node
/**
 * 清掉選項尾巴的「題組題號範圍」與「頁碼／座標數字」。
 *
 *   (D) "仲介協助交易收費低廉 25-26"          ← 25-26 是下一組題組的範圍
 *   (D) "該命令應刊登政府公報或新聞紙31550、31650 32250、32950 33050"  ← 版面座標
 *
 * 最後一個選項後面就是下一段的東西，切題邊界沒抓好就會一路吃進來。
 *
 * **不要用「結尾有數字就刪」**——那會刪掉「民國 105」「西元 1914」這種正常內容。
 * 只認兩種具體樣式，而且前面必須是中文或右括號（數字接在英數後面多半是單位或型號）：
 *   1. 題組範圍   「 25-26」「 13-15」
 *   2. 座標清單   「31550、31650 32250」（多組數字，或連續 6 位以上）
 * 第三種「單獨頁碼」試過但誤判太多，已移除，原因見下方 PATTERNS 的註解。
 *
 *   node scripts/repair-option-page-tail.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./lib/atomic-write');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const LEAD = '[\\u4e00-\\u9fff）)]';
// ⚠️「中文 + 數字～數字」不能一律當成題組範圍切掉。
// 那個形狀在正常選項裡太常見：rt 104020 #80 的「每年惡化次數 0～1」「每年惡化次數 1～2」
// 被切成兩個一模一樣的「每年惡化次數」，整題被毀。
// 真正的題組範圍是**接在本題之後**的題號（第 24 題的選項 D 後面跟著「25-26」），
// 所以要拿題號來驗：起始值必須大於本題題號，且緊接在後。
function isNextGroupRange(from, to, qNum) {
  if (!qNum) return false;
  return from > qNum && from <= qNum + 3 && to >= from && to <= from + 12;
}

const PATTERNS = [
  { name: '題組範圍', checkRange: true, re: new RegExp(`(${LEAD})\\s+(\\d{1,3})\\s*[-－–~～]\\s*(\\d{1,3})\\s*$`) },
  // 座標／頁面編號會是「多組數字」或「一長串數字」。
  // 只要單獨一組 4 位數就切，會削掉正常內容：
  //   audiologist「Hz的純音1000」→「Hz的純音」、dental1「600至1000」→「600至」
  { name: '座標清單', re: new RegExp(`(${LEAD})\\s*(?:\\d{4,6}(?:\\s*[、,]\\s*|\\s+)){1,}\\d{4,6}\\s*$|(${LEAD})\\s*\\d{6,}\\s*$`) },
];
// ⚠️ 曾經還有第三種「單獨頁碼」= 中文後面接一個 1~3 位數。那條誤判太多，已移除：
//   medlab「其淨電荷為 0」→ 削成「其淨電荷為」
//   「Mg(OH) 2」→ 削成「Mg(OH)」（下標被當成頁碼）
//   ast「伊朗 圖 2」→ 削成「伊朗 圖」
// 634 個命中裡光抽 12 個就有 5 個是錯的，單一數字本來就常是答案內容。

const plan = [], banks = {};
const files = [
  ...fs.readdirSync(BK).filter(n => /^questions(-[a-z0-9-]*)?\.json$/.test(n)).map(n => path.join(BK, n)),
  ...fs.readdirSync(path.join(BK, 'shared-banks')).filter(n => /\.json$/.test(n)).map(n => path.join(BK, 'shared-banks', n)),
];
for (const p of files) {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const arr = Array.isArray(raw) ? raw : raw.questions;
  if (!arr) continue;
  banks[p] = { raw, dirty: false };
  for (const q of arr) {
    for (const k of ['A', 'B', 'C', 'D']) {
      const t = String((q.options || {})[k] || '');
      if (!t) continue;
      for (const pat of PATTERNS) {
        const m = pat.re.exec(t);
        if (!m) continue;
        if (pat.checkRange && !isNextGroupRange(+m[2], +m[3], +q.number)) continue;
        const lead = pat.checkRange ? m[1] : (m[1] || m[2]);
        const cut = t.slice(0, m.index + lead.length).trim();
        // 切完太短代表整個選項本來就不是正常選項（pharma2 100030 #80 的選項是醫囑單欄位
        // 「病歷號 1234567」，切完剩「病歷號」一樣沒用），那種題要另外處理，不要在這裡動
        if (cut.length < 4) break;
        plan.push({ file: path.basename(p), id: q.id, n: q.number, k, kind: pat.name,
          before: t.slice(-40), after: cut.slice(-30) });
        if (APPLY) { q.options[k] = cut; banks[p].dirty = true; }
        break;
      }
    }
  }
}

console.log(`選項尾巴有版面殘渣：${plan.length} 個`);
const by = {}; plan.forEach(r => (by[r.kind] = (by[r.kind] || 0) + 1));
console.log('  樣式分布:', JSON.stringify(by));
const byFile = {}; plan.forEach(r => (byFile[r.file] = (byFile[r.file] || 0) + 1));
console.log('  依檔案:', Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => k.replace(/^questions-?|\.json$/g, '') + ':' + v).join('  '));
fs.writeFileSync(path.join(BK, '_tmp', 'option-page-tail.json'), JSON.stringify(plan, null, 1), 'utf8');
plan.slice(0, 10).forEach(r => console.log(`  ✓ [${r.kind}] ${r.file} #${r.n} (${r.k})\n      前…${JSON.stringify(r.before)}\n      後…${JSON.stringify(r.after)}`));
if (APPLY) {
  let n = 0;
  for (const p of Object.keys(banks)) if (banks[p].dirty) { atomicWriteJson(p, banks[p].raw); n++; }
  console.log(`\n已寫回 ${n} 個檔`);
} else console.log('\n(試跑；加 --apply 才寫入)');
