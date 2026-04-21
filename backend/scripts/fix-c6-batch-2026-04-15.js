#!/usr/bin/env node
// Targeted fix for C6's reported truncation case + cluster of related broken
// questions in doctor1 112100 生理學 and pharma1 110/第二次 paper sets.
//
// Reuses the column-aware bbox parser approach from fix-residual-empty-options.js.
// Safe by construction: only writes a question when all 4 options parse cleanly.

const fs = require('fs');
const path = require('path');

const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache');

// (file, id, examPrefix, code, n)
const TARGETS = [
  // doctor1 — C6 cluster
  { file: 'questions.json', id: '112100_1_62', examPrefix: 'doctor1', code: '112100', n: 62 },
  { file: 'questions.json', id: '112100_1_63', examPrefix: 'doctor1', code: '112100', n: 63 }, // ← C6 reported
  { file: 'questions.json', id: '112100_1_64', examPrefix: 'doctor1', code: '112100', n: 64 },
  // doctor1 — other audit hits in 醫學(一)
  { file: 'questions.json', id: '114020_1_77', examPrefix: 'doctor1', code: '114020', n: 77 },
  { file: 'questions.json', id: '115020_1_62', examPrefix: 'doctor1', code: '115020', n: 62 },
  { file: 'questions.json', id: '111020_1_64', examPrefix: 'doctor1', code: '111020', n: 64 },
  { file: 'questions.json', id: '111100_1_66', examPrefix: 'doctor1', code: '111100', n: 66 },
  { file: 'questions.json', id: '113020_1_62', examPrefix: 'doctor1', code: '113020', n: 62 },
  { file: 'questions.json', id: '114020_1_62', examPrefix: 'doctor1', code: '114020', n: 62 },
  { file: 'questions.json', id: '110101_1_61', examPrefix: 'doctor1', code: '110101', n: 61 },

  // pharma1 110/第二次 — entire 9-question cluster of empty options
  { file: 'questions-pharma1.json', id: 115020329, examPrefix: 'pharma1', code: '110101', n: 49 },
  { file: 'questions-pharma1.json', id: 115020330, examPrefix: 'pharma1', code: '110101', n: 50 },
  { file: 'questions-pharma1.json', id: 115020338, examPrefix: 'pharma1', code: '110101', n: 58 },
  { file: 'questions-pharma1.json', id: 115020343, examPrefix: 'pharma1', code: '110101', n: 63 },
  { file: 'questions-pharma1.json', id: 115020351, examPrefix: 'pharma1', code: '110101', n: 71 },
  { file: 'questions-pharma1.json', id: 115020352, examPrefix: 'pharma1', code: '110101', n: 72 },
  { file: 'questions-pharma1.json', id: 115020382, examPrefix: 'pharma1', code: '110101', n: 22 },
  { file: 'questions-pharma1.json', id: 115020495, examPrefix: 'pharma1', code: '110101', n: 55 },
  { file: 'questions-pharma1.json', id: 115020516, examPrefix: 'pharma1', code: '110101', n: 76 },
];

const DRY_RUN = process.argv.includes('--dry');

function findCachedPdfs(examPrefix, code) {
  return fs.readdirSync(PDF_CACHE)
    .filter(f => f.startsWith(`${examPrefix}_${code}_`) && f.endsWith('.pdf'))
    .filter(f => fs.statSync(path.join(PDF_CACHE, f)).size > 50000)
    .map(f => path.join(PDF_CACHE, f));
}

async function pageColumnText(pg) {
  const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON());
  const lines = [];
  for (const b of parsed.blocks || []) {
    if (b.type !== 'text') continue;
    for (const ln of (b.lines || [])) {
      const t = ln.text || '';
      if (!t.trim()) continue;
      lines.push({ y: Math.round(ln.bbox.y * 10) / 10, x: Math.round(ln.bbox.x * 10) / 10, text: t });
    }
  }
  // Detect single-column: in a true 2-column page, no line starts in the [200, 320]
  // x-band (the mid-page gutter). If anything starts there, this page is single-column
  // and mupdf has split visual lines into mid-line spans we must NOT push to a "right column".
  const isSingleColumn = lines.some(l => l.x > 200 && l.x < 320);
  const mid = 300;
  const left = isSingleColumn ? lines : lines.filter(l => l.x < mid);
  const right = isSingleColumn ? [] : lines.filter(l => l.x >= mid);
  const sortCol = arr => arr.sort((a, b) => a.y - b.y || a.x - b.x);
  // Join span texts while removing overlap at boundaries: mupdf can emit
  // overlapping spans (e.g. "下列" + "列何者" → "下列何者"), so detect the
  // longest suffix of the accumulated text that matches a prefix of the next.
  function joinSpans(texts) {
    let out = texts[0] || '';
    for (let i = 1; i < texts.length; i++) {
      const next = texts[i];
      let overlap = 0;
      const max = Math.min(out.length, next.length, 8);
      for (let k = max; k > 0; k--) {
        if (out.slice(-k) === next.slice(0, k)) { overlap = k; break; }
      }
      out += next.slice(overlap);
    }
    return out;
  }
  function group(arr) {
    const groups = [];
    for (const ln of arr) {
      const last = groups[groups.length - 1];
      if (last && Math.abs(last.y - ln.y) <= 3) last.parts.push(ln);
      else groups.push({ y: ln.y, parts: [ln] });
    }
    return groups.map(g => joinSpans(g.parts.sort((a, b) => a.x - b.x).map(p => p.text)));
  }
  return [...group(sortCol(left)), ...group(sortCol(right))].join('\n');
}

async function fullPdfText(buf) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf');
  let txt = '';
  for (let i = 0; i < doc.countPages(); i++) {
    txt += await pageColumnText(doc.loadPage(i)) + '\n';
  }
  return txt;
}

// Extract question N's stem and 4 options from raw text
function extractQA(text, N) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let i = 0;
  const startRe = new RegExp(`^${N}[.．、]\\s*(.*)$`);
  const nextRe = new RegExp(`^${N + 1}[.．、]\\s*`);
  while (i < lines.length && !startRe.test(lines[i])) i++;
  if (i >= lines.length) return null;
  const buf = [];
  let stem = lines[i].replace(startRe, '$1');
  if (stem) buf.push(stem);
  i++;
  const opts = { A: '', B: '', C: '', D: '' };
  let curOpt = null;
  for (; i < lines.length; i++) {
    const ln = lines[i];
    if (nextRe.test(ln)) break;
    const optMatch = ln.match(/^\(?([A-D])\)?[.．、)]\s*(.*)$/);
    if (optMatch) { curOpt = optMatch[1]; opts[curOpt] = optMatch[2]; continue; }
    if (curOpt) opts[curOpt] += ln;
    else buf.push(ln);
  }
  const stemFull = buf.join('').trim();
  if (!stemFull || stemFull.length < 5) return null;
  if (!opts.A || !opts.B || !opts.C || !opts.D) return null;
  return { question: stemFull, options: opts };
}

(async () => {
  const byFile = {};
  for (const t of TARGETS) {
    if (!byFile[t.file]) byFile[t.file] = [];
    byFile[t.file].push(t);
  }
  let totalFixed = 0;
  let totalSkipped = 0;
  for (const [file, list] of Object.entries(byFile)) {
    const fp = path.join(__dirname, '..', file);
    const db = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const qs = db.questions || db;
    let fileFixed = 0;
    console.log(`\n=== ${file} (${list.length} targets) ===`);
    for (const t of list) {
      const q = qs.find(x => x.id == t.id || x.id === String(t.id));
      if (!q) { console.log(`  ✗ id=${t.id}: NOT FOUND`); totalSkipped++; continue; }
      const pdfs = findCachedPdfs(t.examPrefix, t.code);
      let parsed = null, usedPdf = null;
      for (const p of pdfs) {
        try {
          const buf = fs.readFileSync(p);
          const txt = await fullPdfText(buf);
          const r = extractQA(txt, t.n);
          if (r) { parsed = r; usedPdf = path.basename(p); break; }
        } catch { /* try next pdf */ }
      }
      if (!parsed) {
        console.log(`  ✗ id=${t.id} #${t.n}: no PDF match (${pdfs.length} pdfs tried)`);
        totalSkipped++;
        continue;
      }
      console.log(`  ✓ id=${t.id} #${t.n} (${usedPdf})`);
      console.log(`    Q: ${parsed.question.slice(0, 80)}`);
      console.log(`    A: ${parsed.options.A.slice(0, 60)}`);
      console.log(`    B: ${parsed.options.B.slice(0, 60)}`);
      console.log(`    C: ${parsed.options.C.slice(0, 60)}`);
      console.log(`    D: ${parsed.options.D.slice(0, 60)}`);
      if (!DRY_RUN) {
        q.question = parsed.question;
        q.options = parsed.options;
      }
      fileFixed++;
      totalFixed++;
    }
    if (fileFixed && !DRY_RUN) {
      if (db.metadata) db.metadata.last_updated = new Date().toISOString();
      const tmp = fp + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, fp);
    }
  }
  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Total fixed: ${totalFixed}/${TARGETS.length}, skipped: ${totalSkipped}`);
})().catch(e => { console.error(e); process.exit(1); });
