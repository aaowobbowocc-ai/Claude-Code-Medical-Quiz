#!/usr/bin/env node
/**
 * 修「選項文字漏進題幹」：題幹問號之後直接黏著選項 A（有時還連著 B）的內容。
 *
 *   題幹  以下身心障礙觀點的論述中，何者論述有誤？文化觀點下的身心障礙是指社會結構…
 *   (A) 文化觀點下的身心障礙是指社會結構…      ← 與題幹尾巴一模一樣
 *
 * 這型在 audit-all-questions.js 叫 `pollution`。2026-09-22 把一批被切壞的選項
 * 依原卷還原之後，本來看不出來的 12 題就浮出來了——選項 A 修對了，才比得出題幹尾巴
 * 就是選項 A。
 *
 * 判準很窄：題幹在最後一個「？：。」之後還有 20 字以上，而且那段的開頭
 * 就是選項 A 的開頭（用 skeleton 比，至少 10 個字相同）。只截題幹，不動選項與答案。
 *
 *   node scripts/repair-stem-option-leak.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const { skeleton } = require('./lib/moex-normalize');
const { atomicWriteJson } = require('./lib/atomic-write');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');

// 選項標記 ⒶⒷⒸⒹ。漏進題幹時使用者看到的是豆腐字，而且會讓下面的前綴比對失敗
// （common_constitution 115 #24 的題幹尾巴開頭就是 U+E18C，skeleton 不會移除它）。
// 只清這四個已知的標記，其他 PUA 可能是造字（ast/gsat 的數學符號），不要動。
// 兩個版本：帶 g 的用來取代，不帶 g 的用來判斷。
// 帶 g 的 regex 用 .test() 會記住 lastIndex，連續呼叫會每隔一次回傳 false。
const OPT_MARK = /[-]/g;
const HAS_MARK = /[-]/;

/** 題幹尾巴是不是選項 A 的內容；是的話回傳截斷後的題幹 */
function trimLeak(q) {
  const stem = String(q.question || '').replace(OPT_MARK, '');
  const optA = String((q.options || {}).A || '');
  if (!stem || !optA) return null;
  const skA = skeleton(optA);
  if (skA.length < 10) return null;
  // 只在「？：」截，不要在「。」截——題幹中間本來就有句號，
  // 在那裡切會把真正的問句整句砍掉（counseling-psychology #39 實測：
  // 「…同學周末都會喝酒。社會大眾反對未成年飲酒與…分屬下列何者？」被截成第一句）。
  for (let i = stem.length - 1; i >= 10; i--) {
    if (!/[？?：:]/.test(stem[i])) continue;
    const tail = stem.slice(i + 1).trim();
    if (tail.length < 20) continue;
    if (!skeleton(tail).startsWith(skA.slice(0, 10))) continue;
    // 被截掉的那段若自己含問號，它就不是選項而是題幹的一部分——
    // 有些題幹先列舉項目再發問（radiology #62「ICRU 50號報告定義：A、B、C與D。上述何者體積最大？」），
    // 列舉的開頭剛好等於選項 A，照截會把真正的問句砍掉。
    if (/[？?]/.test(tail)) continue;
    const cut = stem.slice(0, i + 1).trim();
    // 截完必須還是個問句，否則代表切點選錯了
    return /[？?：:]$/.test(cut) ? cut : null;
  }
  return null;
}

const plan = [];
const files = [
  ...fs.readdirSync(BK).filter(n => /^questions(-[a-z0-9-]*)?\.json$/.test(n)).map(n => path.join(BK, n)),
  ...fs.readdirSync(path.join(BK, 'shared-banks')).filter(n => /\.json$/.test(n)).map(n => path.join(BK, 'shared-banks', n)),
];
const banks = {};
for (const p of files) {
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const arr = Array.isArray(raw) ? raw : raw.questions;
  if (!arr) continue;
  banks[p] = { raw, dirty: false };
  for (const q of arr) {
    // 沒有漏選項、但題幹殘留選項標記的，也順手清掉（使用者看到的是豆腐字）
    if (HAS_MARK.test(String(q.question || ''))) {
      const cleaned = String(q.question).replace(OPT_MARK, '').replace(/\s{2,}/g, ' ').trim();
      if (cleaned.length >= 12 && APPLY) { q.question = cleaned; banks[p].dirty = true; }
    }
    const cut = trimLeak(q);
    if (!cut || cut.length < 12) continue;
    plan.push({ file: path.basename(p), id: q.id, n: q.number,
      before: String(q.question).replace(/\s+/g, ' ').slice(0, 70),
      after: cut.replace(/\s+/g, ' ').slice(0, 70) });
    if (APPLY) { q.question = cut; banks[p].dirty = true; }
  }
}

console.log(`題幹黏著選項 A 的：${plan.length} 題`);
const by = {}; plan.forEach(r => (by[r.file] = (by[r.file] || 0) + 1));
Object.entries(by).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k} ${v}`));
fs.writeFileSync(path.join(BK, '_tmp', 'stem-leak-plan.json'), JSON.stringify(plan, null, 1), 'utf8');
plan.slice(0, 8).forEach(r => console.log(`  ✓ ${r.file} #${r.n}\n      前: ${r.before}\n      後: ${r.after}`));
if (APPLY) {
  let n = 0;
  for (const p of Object.keys(banks)) if (banks[p].dirty) { atomicWriteJson(p, banks[p].raw); n++; }
  console.log(`\n已寫回 ${n} 個檔`);
} else console.log('\n(試跑；加 --apply 才寫入)');
