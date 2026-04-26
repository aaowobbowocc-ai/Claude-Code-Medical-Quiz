#!/usr/bin/env node
/**
 * OCR gap-fill driver.
 * Reads per-page OCR JSON from _tmp/ocr_json/<prefix>_p{N}.json,
 * parses questions, matches answers from the answer PDF (via pdf-parse),
 * and merges into the target questions bank.
 *
 * Usage:
 *   node scripts/fill-ocr-gaps.js --target tcm1 [--dry]
 *   node scripts/fill-ocr-gaps.js --target nursing [--dry]
 */
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, '_tmp');
const OCR_JSON = path.join(TMP, 'ocr_json');
const PDFS = path.join(TMP, 'ocr_pdfs');

const TARGETS = {
  tcm1: {
    prefix: 'tcm1_p',
    pages: 10,
    qPdf: path.join(PDFS, 'tcm1_102-2_basic2_Q.pdf'),
    sPdf: path.join(PDFS, 'tcm1_102-2_basic2_S.pdf'),
    bank: path.join(ROOT, 'questions-tcm1.json'),
    wanted: new Set([6, 40, 50, 51, 59, 60, 65, 77, 78, 79, 80]),
    meta: {
      roc_year: '102', session: '第二次', exam_code: '102110',
      subject: '中醫基礎醫學(二)', subject_tag: 'tcm_basic_2',
      subject_name: '中醫基礎醫學(二)',
    },
  },
  nursing: {
    prefix: 'nursing_p',
    pages: 8,
    qPdf: path.join(PDFS, 'nursing_108-1_psych_Q.pdf'),
    sPdf: path.join(PDFS, 'nursing_108-1_psych_S.pdf'),
    bank: path.join(ROOT, 'questions-nursing.json'),
    wanted: null, // all
    meta: {
      roc_year: '108', session: '第一次', exam_code: '108020',
      subject: '精神科與社區衛生護理學', subject_tag: 'psych_community',
      subject_name: '精神科與社區衛生護理學',
    },
  },
};

// ----- OCR JSON -> lines (cluster boxes into lines, per page, column-aware) -----
function loadPage(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}
function clusterLines(items, ytol = 18) {
  // sort by cy, then xmin
  const arr = [...items].sort((a, b) => a.cy - b.cy || a.xmin - b.xmin);
  const lines = [];
  let cur = [], curY = null;
  for (const it of arr) {
    if (curY == null || Math.abs(it.cy - curY) <= ytol) {
      cur.push(it);
      curY = curY == null ? it.cy : (curY + it.cy) / 2;
    } else {
      lines.push(cur);
      cur = [it]; curY = it.cy;
    }
  }
  if (cur.length) lines.push(cur);
  return lines.map(line => {
    line.sort((a, b) => a.xmin - b.xmin);
    return {
      text: line.map(w => w.text).join(''),
      parts: line,
      cy: line.reduce((s, w) => s + w.cy, 0) / line.length,
      xmin: Math.min(...line.map(w => w.xmin)),
      xmax: Math.max(...line.map(w => w.xmax)),
    };
  });
}

// Split a "line" into per-column segments based on x ranges.
// MoEX papers are single-column for stems, but options usually sit on one row (A|B|C|D) in 4 columns.
// Better approach: don't cluster across full page width. Cluster using per-box y but split boxes by column based on option anchors.
// Simpler: detect option rows by presence of (A)/(B)/(C)/(D) markers in the same clustered line.

function splitOptionRow(line) {
  // Returns { A, B, C, D } if this line has multiple option markers; else null.
  const opts = {};
  const parts = line.parts;
  // Find option anchors in parts
  const anchors = [];
  parts.forEach((p, i) => {
    const m = p.text.match(/^\(?([ABCD])\)?[.\s、．]?(.*)$/);
    if (m) anchors.push({ idx: i, letter: m[1], rest: m[2] || '' });
  });
  // A valid option row has >=2 distinct letters
  const letters = [...new Set(anchors.map(a => a.letter))];
  if (letters.length < 2) return null;
  // Walk anchors: between each anchor and next, concat parts' text
  for (let k = 0; k < anchors.length; k++) {
    const a = anchors[k];
    const end = k + 1 < anchors.length ? anchors[k + 1].idx : parts.length;
    let txt = a.rest;
    for (let j = a.idx + 1; j < end; j++) txt += parts[j].text;
    opts[a.letter] = (opts[a.letter] || '') + txt;
  }
  return opts;
}

// Detect question-number anchor: text starts with plain "N" digit alone, x at far left (xmin small).
function isQnumAnchor(line) {
  if (!line.parts.length) return null;
  const first = line.parts[0];
  // accept if first box is pure digits 1-2 chars and at small xmin (< 200 px for 300dpi)
  if (!/^\d{1,2}$/.test(first.text.trim())) return null;
  if (first.xmin > 260) return null;
  const n = parseInt(first.text.trim(), 10);
  if (n < 1 || n > 100) return null;
  return n;
}

// Extract questions from page lines.
function parsePages(target) {
  const allLines = [];
  for (let i = 1; i <= target.pages; i++) {
    const fp = path.join(OCR_JSON, `${target.prefix}${i}.json`);
    if (!fs.existsSync(fp)) { console.error('MISSING', fp); continue; }
    const items = loadPage(fp);
    // drop tiny noise boxes? no — keep
    const lines = clusterLines(items);
    // filter out header (cy < 1000 on page 1 only, contains page number etc)
    for (const l of lines) allLines.push({ page: i, ...l });
  }
  return allLines;
}

function extractQuestions(allLines) {
  const qs = new Map(); // number -> { question, options }
  let cur = null;
  let mode = 'pre';
  for (const l of allLines) {
    const text = l.text.trim();
    if (!text) continue;
    // try question anchor
    const qn = isQnumAnchor(l);
    // detect option row
    const opts = splitOptionRow(l);
    if (qn != null && !opts) {
      // close previous
      if (cur && !qs.has(cur.number)) qs.set(cur.number, cur);
      // stem is rest of line after first box
      const stem = l.parts.slice(1).map(p => p.text).join('').trim();
      cur = { number: qn, question: stem, options: {} };
      mode = 'q';
      continue;
    }
    if (opts) {
      if (cur) {
        Object.assign(cur.options, opts);
        mode = 'opt';
        cur._lastOpt = 'D' in opts ? 'D' : Object.keys(opts).sort().pop();
      }
      continue;
    }
    // continuation
    if (!cur) continue;
    if (mode === 'q') cur.question += text;
    else if (mode === 'opt' && cur._lastOpt) cur.options[cur._lastOpt] += text;
  }
  if (cur && !qs.has(cur.number)) qs.set(cur.number, cur);
  return qs;
}

// ----- Answer PDF parsing -----
async function parseAnswerPdf(pdfPath) {
  const buf = fs.readFileSync(pdfPath);
  const { text } = await pdfParse(buf);
  const ans = {};
  // Strategy 1: inline "1.A" or "1、A"
  for (const m of text.matchAll(/(?<!\d)(\d{1,3})\s*[.、．]\s*([A-E#])(?![A-Z])/g)) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 200 && !ans[n]) ans[n] = m[2];
  }
  if (Object.keys(ans).length >= 20) return ans;
  // Strategy 2: "答案" followed by sequence of letters (half or full width)
  const fullWidthMap = { 'Ａ': 'A', 'Ｂ': 'B', 'Ｃ': 'C', 'Ｄ': 'D', 'Ｅ': 'E', '＃': '#' };
  // Collect all "答案" blocks
  const blocks = text.split(/答\s*案/);
  let out = [];
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    // take chars until next non-letter cluster ends
    const cleaned = b.split('').map(c => fullWidthMap[c] || c).join('');
    const letters = cleaned.match(/[ABCDE#]/g) || [];
    if (letters.length >= 10) out = out.concat(letters);
  }
  if (out.length) {
    out.forEach((l, i) => { if (!ans[i + 1] && 'ABCDE'.includes(l)) ans[i + 1] = l; });
  }
  return ans;
}

// ----- bank merge -----
function sessionCode(sess) {
  return { '第一次': '0101', '第二次': '0202' }[sess] || '0000';
}
function buildEntry(meta, num, question, options, answer) {
  return {
    id: `${meta.exam_code}_${sessionCode(meta.session)}_${num}`,
    roc_year: meta.roc_year,
    session: meta.session,
    exam_code: meta.exam_code,
    subject: meta.subject,
    subject_tag: meta.subject_tag,
    subject_name: meta.subject_name,
    stage_id: 0,
    number: num,
    question,
    options,
    answer,
    explanation: '',
  };
}

function merge(bankPath, entries) {
  const data = JSON.parse(fs.readFileSync(bankPath, 'utf-8'));
  const existing = new Set(data.questions.map(q => `${q.exam_code}|${q.subject_tag}|${q.number}`));
  let added = 0;
  for (const e of entries) {
    const k = `${e.exam_code}|${e.subject_tag}|${e.number}`;
    if (existing.has(k)) continue;
    data.questions.push(e); added++;
  }
  data.total = data.questions.length;
  fs.writeFileSync(bankPath, JSON.stringify(data, null, 2), 'utf-8');
  return added;
}

async function runTarget(name, target, dry) {
  console.log(`\n=== ${name} ===`);
  const lines = parsePages(target);
  console.log(`  lines: ${lines.length}`);
  const qsMap = extractQuestions(lines);
  console.log(`  parsed questions: ${qsMap.size} (numbers: ${[...qsMap.keys()].sort((a, b) => a - b).join(',')})`);

  // answers
  let answers = {};
  if (fs.existsSync(target.sPdf)) {
    try {
      answers = await parseAnswerPdf(target.sPdf);
      console.log(`  answers parsed: ${Object.keys(answers).length}`);
    } catch (e) { console.error('  answer parse error:', e.message); }
  } else {
    console.warn('  NO answer PDF at', target.sPdf);
  }

  // filter
  const entries = [];
  const skipped = [];
  for (const [num, q] of qsMap) {
    if (target.wanted && !target.wanted.has(num)) continue;
    const opts = q.options;
    if (!['A', 'B', 'C', 'D'].every(k => opts[k] != null && opts[k].length > 0)) {
      skipped.push({ num, reason: 'missing_opts', have: Object.keys(opts) });
      continue;
    }
    const ans = answers[num];
    if (!ans) { skipped.push({ num, reason: 'no_answer' }); continue; }
    if (!q.question.trim()) { skipped.push({ num, reason: 'no_stem' }); continue; }
    entries.push(buildEntry(target.meta, num,
      q.question.trim(),
      { A: opts.A.trim(), B: opts.B.trim(), C: opts.C.trim(), D: opts.D.trim() },
      ans));
  }

  console.log(`  entries built: ${entries.length}`);
  if (skipped.length) console.log(`  skipped:`, skipped.slice(0, 20));
  // spot-check
  for (const e of entries.slice(0, 3)) {
    console.log(`  --- Q${e.number} ANS=${e.answer} ---`);
    console.log(`    stem: ${e.question.slice(0, 100)}`);
    for (const k of 'ABCD') console.log(`    (${k}) ${e.options[k].slice(0, 80)}`);
  }

  if (dry) {
    console.log(`  DRY: would add ${entries.length}`);
    return 0;
  }
  const added = merge(target.bank, entries);
  console.log(`  merged into ${path.basename(target.bank)}: +${added}`);
  return added;
}

(async () => {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const tIdx = args.indexOf('--target');
  const which = tIdx >= 0 ? args[tIdx + 1] : 'all';
  let total = 0;
  if (which === 'all' || which === 'tcm1') total += await runTarget('tcm1_102-2_basic2', TARGETS.tcm1, dry);
  if (which === 'all' || which === 'nursing') total += await runTarget('nursing_108-1_psych', TARGETS.nursing, dry);
  console.log(`\nDONE. total added: ${total}`);
})();
