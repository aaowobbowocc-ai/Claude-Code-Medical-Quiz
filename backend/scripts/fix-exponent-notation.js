#!/usr/bin/env node
/**
 * 考選部 PDF 把上標壓平後，「1.1×10⁻¹」會變成「1.1×10 -1」或「1.1×10-1」，
 * 讀起來像「10 減 1」。改用 Unicode 上標寫回去，語意才明確。
 *
 * **只處理負指數**。正指數不能碰：百分比公式裡的「×100」會被當成 ×10⁰，
 * 「2×1012」也分不出是 10¹² 還是 1012。負號是唯一不會有歧義的訊號。
 *
 *   node scripts/fix-exponent-notation.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const SUP = { '0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','-':'⁻' };
const sup = s => s.split('').map(c => SUP[c] || c).join('');

// ×10 後接（可選空白）負號＋數字，或（可選空白）純數字且該數字不是緊接單位的一部分
const NEG = /([×x])\s*10\s*[-−–]\s*(\d{1,2})(?![\d.])/g;


const fix = t => {
  if (typeof t !== 'string') return t;
  return t.replace(NEG, (_, m, d) => `${m}10${sup('-' + d)}`);
};

const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f));
let total = 0; const by = {}; const samples = [];
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
  const a = Array.isArray(j) ? j : j.questions; if (!a) continue;
  let n = 0;
  for (const q of a) {
    let hit = false;
    const nq = fix(q.question);
    if (nq !== q.question) { if (samples.length < 6) samples.push(`${f} #${q.number} 題幹: ${String(q.question).slice(0,60)} → ${nq.slice(0,60)}`); if (APPLY) q.question = nq; hit = true; }
    for (const k of Object.keys(q.options || {})) {
      const nv = fix(q.options[k]);
      if (nv !== q.options[k]) { if (samples.length < 6) samples.push(`${f} #${q.number} ${k}: ${q.options[k]} → ${nv}`); if (APPLY) q.options[k] = nv; hit = true; }
    }
    if (hit) n++;
  }
  if (n) { by[f] = n; total += n; if (APPLY) fs.writeFileSync(path.join(BK, f), JSON.stringify(j, null, 2), 'utf8'); }
}
console.log((APPLY ? '已修正 ' : '可修正 ') + total + ' 題');
console.log(JSON.stringify(by, null, 1));
samples.forEach(s => console.log('  ', s));
