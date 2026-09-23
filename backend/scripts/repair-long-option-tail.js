#!/usr/bin/env node
/**
 * 修「選項吞進了下一段的文章」。
 *
 *   (A) crude  (B) enjoyable(9字)  (C) …  (D) 949 字
 *   (D) "enjoyable 100 年學測 第 2 頁 英文考科 … 二、綜合測驗（占15分）說明︰第16題至第30題…"
 *
 * 真正的選項在最前面，後面整段都是下一個題組／下一頁的內容。
 * 181 題裡有 174 題出在選項 D——它是最後一個選項，切題的邊界沒抓好就會一路吃到下一段。
 *
 * 切點只認**明確的邊界標記**（頁首、題組宣告、大題說明、卷面符號）。
 * 沒有可信切點的就不動——寧可留著長選項，也不要亂切（下面 cutPoint 記了慘痛教訓）。
 *
 * 切完還要通過檢查：不得短於 3 字，也不得超過其他選項最長者的 3 倍（本身 ≤40 字則放行）。
 *
 *   node scripts/repair-long-option-tail.js [--apply] [--min=300]
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./lib/atomic-write');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const MIN = +((process.argv.find(a => a.startsWith('--min=')) || '').split('=')[1] || 300);

// 明確的邊界：頁首、題組宣告、大題說明
const MARKERS = [
  /\d{2,3}\s*年\s*(?:學測|指考|分科|統測)/,
  /第\s*\d+\s*頁/,
  /\d+\s*[-－–~～]\s*\d+\s*(?:題)?\s*為題組/,
  /為題組/,
  /[◎◆■★▲▼]/,
  /第\s*\d+\s*[至~～－-]\s*\d+\s*題/,
  /說明\s*[︰:：]/,
  /\n?\s*[一二三四五六七八九十]\s*、\s*[^\s]{2,6}\s*(?:測驗|題組|閱讀)/,
  // 學測／分科的卷面分隔（「第貳部分、混合題或非選擇題（占 36 分）」）
  /第\s*[壹貳參肆伍陸]\s*部分/,
  /（\s*占\s*\d+\s*分\s*）/,
  /非選擇題/,
  /答題卷/,
  // 選項吞進圖表內容或下一篇閱讀（ast 的地理題常見）
  /[圖表]\s*\d+/,
  /閱讀\s*[一二三四五六七八九十]/,
];

/**
 * 回傳切點索引（找不到回 -1）。
 *
 * ⚠️ 曾經多加一條「小寫英文字後面接大寫字或數字就切」的規則，想順便處理
 * 英文單字題。那條規則會把**正常的英文散文**從中間切斷：
 *   - gsat_103 #44 的閱讀測驗選項被切到只剩 2 個字
 *   - radiology 含圖題的圖片描述「A chemical structure diagram depicting
 *     Technetium-99m…」被切成「A chemical structure diagram depicting」，
 *     四個選項還因此變成一模一樣
 * 142 個切點裡有 21 個沒有明確標記，其中好幾個是這樣切壞的。已移除那條規則：
 * **只認明確的卷面標記**，寧可少修也不要把好選項切爛。
 */
function cutPoint(t) {
  let best = -1;
  for (const re of MARKERS) {
    const m = re.exec(t);
    if (m && m.index > 0 && (best < 0 || m.index < best)) best = m.index;
  }
  return best;
}

const plan = [], skip = [];
const banks = {};
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
    if (q.incomplete) continue;
    const o = q.options || {};
    for (const k of Object.keys(o)) {
      const t = String(o[k] || '');
      if (t.length <= MIN) continue;
      const others = Object.keys(o).filter(x => x !== k).map(x => String(o[x] || '').length);
      const maxOther = Math.max(1, ...others);
      const i = cutPoint(t);
      const label = `${path.basename(p)} ${q.exam_code || q.roc_year} #${q.number} (${k})`;
      if (i < 0) { skip.push({ label, len: t.length, why: '找不到可信切點' }); continue; }
      const cut = t.slice(0, i).trim();
      if (cut.length < 3) { skip.push({ label, len: t.length, why: '切完太短，切點不對' }); continue; }
      // 其他選項很短時（「3-4 月」才 5 字）比例門檻會過嚴，所以本身夠短就放行
      if (cut.length > maxOther * 3 && cut.length > 40) { skip.push({ label, len: t.length, cut: cut.length, why: '切完仍比其他選項長太多' }); continue; }
      plan.push({ label, file: p, id: q.id, k, from: t.length, to: cut.length,
        cut, dropped: t.slice(i).trim().slice(0, 44) });
      if (APPLY) { o[k] = cut; banks[p].dirty = true; }
    }
  }
}

console.log(`選項 >${MIN} 字：${plan.length + skip.length} 個，可切 ${plan.length}，不動 ${skip.length}`);
const byWhy = {}; skip.forEach(r => (byWhy[r.why] = (byWhy[r.why] || 0) + 1));
Object.entries(byWhy).forEach(([w, n]) => console.log(`  ${n} — ${w}`));
fs.writeFileSync(path.join(BK, '_tmp', 'long-option-plan.json'), JSON.stringify({ plan, skip }, null, 1), 'utf8');
plan.slice(0, 12).forEach(r => console.log(`  ✓ ${r.label} ${r.from}→${r.to} 字\n      留: ${JSON.stringify(r.cut.slice(0, 50))}\n      切: ${JSON.stringify(r.dropped)}…`));
if (APPLY) {
  let n = 0;
  for (const p of Object.keys(banks)) if (banks[p].dirty) { atomicWriteJson(p, banks[p].raw); n++; }
  console.log(`\n已寫回 ${n} 個檔`);
} else console.log('\n(試跑；加 --apply 才寫入)');
