#!/usr/bin/env node
/**
 * 清掉選項尾巴的卷面頁首殘渣。
 *
 *   (D) "它不包括書寫語言理解代號：6113頁次：6－2"
 *   (D) "①②③④⑤代號：6113頁次：6－4"
 *
 * 考選部 PDF 每頁頁首都有「代號：NNNN 頁次：N－N」，最後一個選項跨頁時會把它一起收進來。
 * 全站 454 個選項有這個殘渣，集中在聽力師（238）與語言治療師（205）。
 *
 * 只從**第一個「代號：」或「頁次：」開始往後整段刪**，並檢查刪完不為空、
 * 不與其他選項重複。刪不乾淨或會出事的就不動。
 *
 *   node scripts/repair-page-header-residue.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const { optionKey } = require('./lib/moex-normalize');
const { atomicWriteJson } = require('./lib/atomic-write');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
// 選項：殘渣一定在尾巴，「代號：」「頁次：」之後整段刪
const HEADER = /\s*(?:代\s*號|頁\s*次)\s*[：:][\s\S]*$/;
// 題幹：殘渣夾在文章中間（跨頁的閱讀測驗），只能刪掉那幾個 token，不能整段截掉
const HEADER_TOKENS = [
  /代\s*號\s*[：:]\s*\d+/g,
  /頁\s*次\s*[：:]\s*[\d０-９]+\s*[-－–—]\s*[\d０-９]+/g,
];

const plan = [], skip = [], banks = {};
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
    // 題幹：只刪頁首 token（跨頁的閱讀測驗，殘渣夾在文章中間）
    const st = String(q.question || '');
    if (HEADER_TOKENS.some(re => { re.lastIndex = 0; return re.test(st); })) {
      let cleaned = st;
      for (const re of HEADER_TOKENS) cleaned = cleaned.replace(re, ' ');
      cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
      const label = `${path.basename(p)} ${q.exam_code || q.roc_year} #${q.number} (題幹)`;
      if (cleaned.length < 12) skip.push({ label, why: '刪完題幹太短' });
      else {
        plan.push({ label, file: p, id: q.id, k: '題幹', before: st.replace(/\s+/g, ' ').slice(0, 50), after: cleaned.replace(/\s+/g, ' ').slice(0, 50) });
        if (APPLY) { q.question = cleaned; banks[p].dirty = true; }
      }
    }
    const o = q.options || {};
    const keys = Object.keys(o);
    for (const k of keys) {
      const t = String(o[k] || '');
      if (!HEADER.test(t)) continue;
      const label = `${path.basename(p)} ${q.exam_code || q.roc_year} #${q.number} (${k})`;
      const cut = t.replace(HEADER, '').trim();
      if (!cut) { skip.push({ label, why: '刪完是空的' }); continue; }
      const others = keys.filter(x => x !== k).map(x => optionKey(String(o[x] || '')));
      if (others.includes(optionKey(cut))) { skip.push({ label, why: '刪完會與其他選項重複' }); continue; }
      plan.push({ label, file: p, id: q.id, k, before: t.slice(-40), after: cut.slice(-40) });
      if (APPLY) { o[k] = cut; banks[p].dirty = true; }
    }
  }
}

console.log(`含頁首殘渣的選項：${plan.length + skip.length} 個，可清 ${plan.length}，不動 ${skip.length}`);
const byWhy = {}; skip.forEach(r => (byWhy[r.why] = (byWhy[r.why] || 0) + 1));
Object.entries(byWhy).forEach(([w, n]) => console.log(`  ${n} — ${w}`));
fs.writeFileSync(path.join(BK, '_tmp', 'header-residue-plan.json'), JSON.stringify({ plan, skip }, null, 1), 'utf8');
plan.slice(0, 8).forEach(r => console.log(`  ✓ ${r.label}\n      前…${JSON.stringify(r.before)}\n      後…${JSON.stringify(r.after)}`));
if (APPLY) {
  let n = 0;
  for (const p of Object.keys(banks)) if (banks[p].dirty) { atomicWriteJson(p, banks[p].raw); n++; }
  console.log(`\n已寫回 ${n} 個檔`);
} else console.log('\n(試跑；加 --apply 才寫入)');
