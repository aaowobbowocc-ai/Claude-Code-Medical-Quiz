#!/usr/bin/env node
// Residual fix batch (10 questions) after C6 batch + medlab/pt/vet batch.
// Reuses the column-aware mupdf parser with single-column detection,
// span overlap dedupe, and page-furniture stripping.

const fs = require('fs');
const path = require('path');

const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache');

const TARGETS = [
  { file: 'questions-doctor2.json', id: 115020917, examPrefix: 'doctor2', code: '111080', n: 57 },
  { file: 'questions-doctor2.json', id: 115021048, examPrefix: 'doctor2', code: '112080', n: 28 },
  { file: 'questions-ot.json',      id: 1551,      examPrefix: 'ot',      code: '112100', n: 31 },
  { file: 'questions-ot.json',      id: 1796,      examPrefix: 'ot',      code: '112100', n: 36 },
  { file: 'questions-pharma1.json', id: '111020_2_54', examPrefix: 'pharma1', code: '111020', n: 54 },
  { file: 'questions-pharma1.json', id: 115020383, examPrefix: 'pharma1', code: '110101', n: 23 },
  { file: 'questions-pharma1.json', id: 115020492, examPrefix: 'pharma1', code: '110101', n: 52 },
  { file: 'questions-nursing.json', id: '110030_0301_20', examPrefix: 'nursing', code: '110030', n: 20 },
  { file: 'questions-tcm2.json',    id: 1941,      examPrefix: 'tcm2',    code: '110030', n: 21 },
  { file: 'questions.json',         id: '110101_1_64', examPrefix: 'doctor1', code: '110101', n: 64 },
];

const DRY_RUN = process.argv.includes('--dry');

function findCachedPdfs(examPrefix, code) {
  // Match both tcm2_110030_*.pdf AND tcm2_110_1_Q_110030_*.pdf style filenames.
  return fs.readdirSync(PDF_CACHE)
    .filter(f => f.endsWith('.pdf'))
    .filter(f => {
      if (!f.startsWith(`${examPrefix}_`)) return false;
      // exact direct prefix
      if (f.startsWith(`${examPrefix}_${code}_`)) return true;
      // alternate style: <examPrefix>_<anything>_<code>_*
      return new RegExp(`^${examPrefix}_[^_]+(?:_[^_]+)*_${code}_`).test(f);
    })
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
      if (/座號|准考證|姓\s*名|代號：|頁次：|^第\s*\d+\s*頁/.test(t)) continue;
      lines.push({ y: Math.round(ln.bbox.y * 10) / 10, x: Math.round(ln.bbox.x * 10) / 10, text: t });
    }
  }
  const isSingleColumn = lines.some(l => l.x > 200 && l.x < 320);
  const mid = 300;
  const left = isSingleColumn ? lines : lines.filter(l => l.x < mid);
  const right = isSingleColumn ? [] : lines.filter(l => l.x >= mid);
  const sortCol = arr => arr.sort((a, b) => a.y - b.y || a.x - b.x);
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
  const skipped = [];
  for (const [file, list] of Object.entries(byFile)) {
    const fp = path.join(__dirname, '..', file);
    const db = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const qs = db.questions || db;
    let fileFixed = 0;
    console.log(`\n=== ${file} (${list.length} targets) ===`);
    for (const t of list) {
      const q = qs.find(x => x.id == t.id || x.id === String(t.id));
      if (!q) { console.log(`  ✗ id=${t.id}: NOT FOUND`); skipped.push({ ...t, why: 'not-found' }); continue; }
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
        skipped.push({ ...t, why: 'no-pdf-match' });
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
  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Total fixed: ${totalFixed}/${TARGETS.length}`);
  if (skipped.length) {
    console.log(`Skipped (${skipped.length}):`);
    for (const s of skipped) console.log(`  - ${s.file} id=${s.id} #${s.n} (${s.examPrefix}/${s.code}) — ${s.why}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
