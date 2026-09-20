#!/usr/bin/env node
/**
 * 獨立驗證 repair-by-option-markers 的結果。
 *
 * 刻意**不用重建時的同一個解析器**（那會是套套邏輯）。改用 pdfText 的扁平文字：
 * 四個選項必須在題幹之後、依 A→B→C→D 依序出現且不重疊。
 * 短選項常互為子字串，所以用 24 種排列找唯一遞增解。
 *
 *   node scripts/verify-marker-repairs.js --exam speech-therapist [--sample 40]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { pdfText } = require('./lib/moex-pdf-parse');

const BK = path.join(__dirname, '..');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];
const SAMPLE = +((process.argv.find(a => a.startsWith('--sample=')) || '').split('=')[1] || 0);
const flat = s => String(s || '').replace(/\s+/g, '');

function orderOk(win, opts) {
  const occ = opts.map(o => { const f = flat(o), r = []; if (!f) return r;
    for (let i = win.indexOf(f); i >= 0 && r.length < 40; i = win.indexOf(f, i + 1)) r.push({ i, len: f.length }); return r; });
  if (occ.some(o => !o.length)) return null;
  const perms = []; (function pm(c, r) { if (!r.length) { perms.push(c.slice()); return; }
    for (let k = 0; k < r.length; k++) pm(c.concat(r[k]), r.filter((_, m) => m !== k)); })([], [0, 1, 2, 3]);
  const sols = [];
  for (const p of perms) { let end = -1, ok = true;
    for (const k of p) { const c = occ[k].find(o => o.i >= end); if (!c) { ok = false; break; } end = c.i + c.len; }
    if (ok) sols.push(p); }
  if (!sols.length) return false;
  return sols.some(p => p.join() === '0,1,2,3');
}

(async () => {
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f));
  let pass = 0, fail = 0, unk = 0, checked = 0, errs = 0;
  const bad = [];
  for (const f of files) {
    const exam = f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '');
    if (only && exam !== only) continue;
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions; if (!arr) continue;
    const g = {};
    for (const q of arr) { if (!q.exam_code) continue; const k = q.exam_code + '|' + q.subject; (g[k] = g[k] || []).push(q); }
    for (const k of Object.keys(g)) {
      if (SAMPLE && checked >= SAMPLE) break;
      const [code, ...rest] = k.split('|'); const subject = rest.join('|');
      const items = g[k];
      let ft;
      try {
        const p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items });
        if (!p) continue;
        ft = flat(await pdfText(await fetchSheet('Q', code, p.c, p.s)));
      } catch (e) { errs++; console.error(`  ! ${exam} ${code} ${subject}: ${String(e.message).slice(0,50)}`); continue; }
      for (const it of items) {
        if (SAMPLE && checked >= SAMPLE) break;
        const opts = ['A', 'B', 'C', 'D'].map(x => String((it.options || {})[x] || ''));
        if (opts.some(o => !o.trim()) || it.option_images) continue;
        const fs2 = flat(it.question);
        let si = -1;
        for (const pr of [fs2.slice(0, 20), fs2.slice(0, 14), fs2.slice(4, 20)]) { if (pr.length < 8) continue; si = ft.indexOf(pr); if (si >= 0) break; }
        if (si < 0) { unk++; continue; }
        checked++;
        const win = ft.slice(si + fs2.length - 4, si + fs2.length + opts.reduce((n, o) => n + flat(o).length, 0) + 80);
        const r = orderOk(win, opts);
        if (r === true) pass++;
        else if (r === false) { fail++; bad.push(`${exam} ${code} ${subject} #${it.number}`); }
        else unk++;
      }
    }
  }
  console.log(`\n驗證 ${checked} 題｜順序正確 ${pass}｜順序錯誤 ${fail}｜無法驗證 ${unk}${errs ? `｜⚠️ ${errs} 卷取不到原卷` : ''}`);
  if (bad.length) { console.log('順序錯誤的題：'); bad.slice(0, 30).forEach(b => console.log('  ✗', b)); }
})().catch(e => { console.error(e.stack); process.exit(1); });
