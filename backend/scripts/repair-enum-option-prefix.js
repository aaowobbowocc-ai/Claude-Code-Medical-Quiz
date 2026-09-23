#!/usr/bin/env node
/**
 * 修「圈號組合題的某個選項前面黏了題幹尾巴」。
 *
 *   題幹  …則下列那些為宜？①鼓風式瓦斯炒爐 ②電烤箱 ③蒸庫 ④煎臺 ⑤蒸汽迴轉鍋
 *   (A) "箱 ③蒸庫 ④煎臺 ⑤蒸汽迴轉鍋 ①②③"   ← 真正的選項只有結尾的「①②③」
 *   (B) "①③⑤"   (C) "②③④"   (D) "②④⑤"
 *
 * 判準很窄：**其他選項至少兩個是純圈號組合**，而這個選項的結尾也是圈號組合，
 * 前面卻黏了別的東西。這種題型的選項只可能是圈號組合，所以尾端那段就是答案本體。
 *
 *   node scripts/repair-enum-option-prefix.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./lib/atomic-write');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const PURE = /^[①-⑳㉑-㉟]+$/;          // 整個選項就是圈號組合
const RUNS = /[①-⑳㉑-㉟]+/g;            // 所有連續圈號片段

/**
 * 取「最長的一段連續圈號」當作真正的選項。
 * 漏進來的碎片**兩端都可能**：
 *   dental2 109020卷二 #60 (D) "①②③④ ②黑紙③鉛片④"      ← 碎片在後，正解是開頭的 ①②③④
 *   speech 104100 #56 (A) "⑥transcortical…⑦pure word deafness ①③④⑥" ← 碎片在前
 *   speech 104100 #56 (D) "②④⑤⑦ ⑦ A ② ⑥ B ④ ① ⑤ ③ M m a"  ← 碎片在後（圖標籤）
 * 只取結尾那段會把第一種切成只剩「④」。
 */
function longestRun(t) {
  let best = '';
  for (const m of String(t).matchAll(RUNS)) if (m[0].length > best.length) best = m[0];
  return best;
}

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
    if (q.incomplete) continue;
    const o = q.options || {};
    const keys = Object.keys(o);
    for (const k of keys) {
      const t = String(o[k] || '').trim();
      if (!t || PURE.test(t)) continue;
      const others = keys.filter(x => x !== k).map(x => String(o[x] || '').trim());
      if (others.filter(x => PURE.test(x)).length < 2) continue;   // 不是圈號組合題
      let cut = longestRun(t);
      if (cut.length < 2) continue;
      // 圈號前面若本來就有「僅」「只有」，那是考選部的原文，要留著
      const at = t.indexOf(cut);
      const lead = /(僅|只有|只|唯)$/.exec(t.slice(0, at).trim());
      if (lead) cut = lead[1] + cut;
      // 「僅①③」「只有②」是考選部原本就這樣印的，多出來的字很少。
      // 要丟掉 8 個字以上才算是碎片（實測不設限會誤刪 890 個「僅」）。
      if (t.length - cut.length < 8) continue;
      // 切完不能和別的選項一樣（圈號塌成 ①①⑤⑦ 時會撞在一起）
      if (others.some(x => x === cut)) continue;
      plan.push({ file: p, id: q.id,
        label: `${path.basename(p)} ${q.exam_code || q.roc_year} #${q.number} (${k})`,
        before: t.slice(0, 40), after: cut });
      if (APPLY) { o[k] = cut; banks[p].dirty = true; }
    }
  }
}

console.log(`圈號組合題的選項前面黏了東西：${plan.length} 個`);
fs.writeFileSync(path.join(BK, '_tmp', 'enum-option-plan.json'), JSON.stringify(plan, null, 1), 'utf8');
plan.forEach(r => console.log(`  ✓ ${r.label}\n      前: ${JSON.stringify(r.before)}\n      後: ${JSON.stringify(r.after)}`));
if (APPLY) {
  let n = 0;
  for (const p of Object.keys(banks)) if (banks[p].dirty) { atomicWriteJson(p, banks[p].raw); n++; }
  console.log(`\n已寫回 ${n} 個檔`);
} else console.log('\n(試跑；加 --apply 才寫入)');
