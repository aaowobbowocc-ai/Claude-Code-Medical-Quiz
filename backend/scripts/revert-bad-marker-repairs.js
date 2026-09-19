#!/usr/bin/env node
/**
 * 還原 repair-by-option-markers 產生的壞結果。
 *
 * 標記解析在部分版型會塌掉：四個選項變成一模一樣、圈圈數字被壓成 ①①①、
 * 或殘留 PUA。這些題從 git HEAD（本輪修改前的狀態）還原。
 * 只動「現在有缺陷、且與 HEAD 不同」的題——HEAD 本來就壞的還原後也一樣，無害。
 *
 *   node scripts/revert-bad-marker-repairs.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { normText } = require('./lib/moex-normalize');

const BK = path.join(__dirname, '..');
const REPO = path.join(BK, '..');
const APPLY = process.argv.includes('--apply');

const defects = (q) => {
  const v = ['A', 'B', 'C', 'D'].map(k => String((q.options || {})[k] || '')).filter(x => x.trim());
  const d = [];
  if (v.length >= 2 && new Set(v.map(normText)).size < v.length && !q.option_images) d.push('選項重複');
  if (/[-]/.test(JSON.stringify(q))) d.push('PUA');
  if (v.length < 4) d.push('選項不足');
  return d;
};

const headCache = {};
function headMap(file) {
  if (headCache[file]) return headCache[file];
  const raw = execFileSync('git', ['show', `HEAD:backend/${file}`], { cwd: REPO, maxBuffer: 1024 * 1024 * 1024 }).toString('utf8');
  const j = JSON.parse(raw);
  const a = Array.isArray(j) ? j : j.questions;
  const m = new Map();
  for (const q of a) m.set(String(q.id), q);
  return (headCache[file] = m);
}

const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f));
let restored = 0, stillBad = 0, notInHead = 0;
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
  const arr = Array.isArray(j) ? j : j.questions; if (!arr) continue;
  const bad = arr.filter(q => defects(q).length);
  if (!bad.length) continue;
  let head;
  try { head = headMap(f); } catch (e) { console.log('  ! 取不到 HEAD 版本', f); continue; }
  let n = 0;
  for (const q of bad) {
    const h = head.get(String(q.id));
    if (!h) { notInHead++; continue; }
    const same = JSON.stringify(h.options) === JSON.stringify(q.options) && String(h.question) === String(q.question);
    if (same) { stillBad++; continue; }                 // HEAD 本來就這樣，不是我弄壞的
    if (defects(h).length) { stillBad++; continue; }    // HEAD 版本也有缺陷，還原沒意義
    if (APPLY) { q.question = h.question; q.options = h.options; q.answer = h.answer; }
    n++; restored++;
  }
  if (n) { console.log(`${f}: ${APPLY ? '已還原' : '可還原'} ${n} 題`); if (APPLY) fs.writeFileSync(path.join(BK, f), JSON.stringify(j, null, 2), 'utf8'); }
}
console.log(`\n${APPLY ? '已還原' : '可還原'} ${restored} 題｜HEAD 也是壞的 ${stillBad} 題｜HEAD 查無 ${notInHead} 題`);
