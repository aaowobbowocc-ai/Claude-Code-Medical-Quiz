#!/usr/bin/env node
/**
 * 驗證並釋放 incomplete='option_order_unverified' 的題。
 *
 * 那個標記是跨科目覆蓋修復時打的：題幹從原卷取回來了，但選項順序無法確認
 * （pdfQuestions 的順序在雙欄版型會整組轉一格）。隱藏是當時的保守作法。
 * 這裡用 pdfText 的閱讀順序驗證：四個選項在「題幹之後的扁平文字」裡
 * 必須依 A→B→C→D 依序出現。對得上就解除隱藏，對不上就維持隱藏。
 *
 *   node scripts/verify-option-order.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { pdfText } = require('./lib/moex-pdf-parse');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const flat = s => String(s).replace(/\s+/g, '');

(async () => {
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f));
  const cache = {};
  let pass = 0, fail = 0, unk = 0;
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions; if (!arr) continue;
    const targets = arr.filter(q => q.incomplete === 'option_order_unverified');
    if (!targets.length) continue;
    const exam = f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '');
    let touched = false;
    for (const q of targets) {
      const key = f + '|' + q.exam_code + '|' + q.subject;
      if (cache[key] === undefined) {
        try {
          const items = arr.filter(x => x.exam_code === q.exam_code && x.subject === q.subject);
          const p = await resolvePaper({ exam, code: q.exam_code, subject: q.subject, year: String(q.exam_code).slice(0, 3), items });
          cache[key] = p ? flat(await pdfText(await fetchSheet('Q', q.exam_code, p.c, p.s))) : null;
        } catch (e) { cache[key] = null; }
      }
      const ft = cache[key];
      if (!ft) { unk++; continue; }
      const fs2 = flat(q.question);
      let si = -1;
      for (const pr of [fs2.slice(0, 20), fs2.slice(0, 14), fs2.slice(4, 20), fs2.slice(0, 10)]) {
        if (pr.length < 8) continue; si = ft.indexOf(pr); if (si >= 0) break;
      }
      if (si < 0) { unk++; continue; }
      const opts = ['A', 'B', 'C', 'D'].map(k => flat((q.options || {})[k] || ''));
      if (opts.some(o => !o)) { unk++; continue; }
      const win = ft.slice(si + fs2.length - 4, si + fs2.length + opts.reduce((n, o) => n + o.length, 0) + 60);
      let end = -1, ok = true;
      for (const o of opts) { const i = win.indexOf(o, Math.max(0, end)); if (i < 0 || i < end) { ok = false; break; } end = i + o.length; }
      if (ok) { if (APPLY) { delete q.incomplete; touched = true; } pass++; }
      else { fail++; console.log('  ✗ 順序不符', f, q.exam_code, q.subject, '#' + q.number); }
    }
    if (APPLY && touched) fs.writeFileSync(path.join(BK, f), JSON.stringify(j, null, 2), 'utf8');
    console.log(f, '→ 待驗', targets.length);
  }
  console.log(`\n順序正確 ${pass}（${APPLY ? '已解除隱藏' : '可解除隱藏'}）｜順序不符 ${fail}｜無法驗證 ${unk}`);
})().catch(e => { console.error(e.stack); process.exit(1); });
