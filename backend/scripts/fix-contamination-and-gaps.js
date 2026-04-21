#!/usr/bin/env node
// Targeted fix for:
//   1. Nursing TCM contamination (~13 known bad questions in 106030-108110)
//      — re-downloads from correct c=106 URLs and replaces content in DB
//   2. tcm2 108110 中醫臨床(一) Q33 — missing, add if found
//   3. customs 110050 法學知識 Q8,31,34,36,40 — missing, add if found
//
// Writes to: questions-nursing.json, questions-tcm2.json, questions-customs.json
// Idempotent: replaces by (exam_code, subject, number), preserves existing id.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')
const { parseQuestionsColumnAware, parseAnswersColumnAware, parseAnswersPdfParse,
        cachedPdf, fetchPdfRaw } = require('./scrape-nursing-nutrition-sw-old')

// mupdf-based parser with relaxed anchor detection:
// Accepts numbers both as standalone ("60") and as line-leading ("60 Beta...").
async function parseQuestionsMupdfRelaxed(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n = doc.countPages()

  const allLines = []  // { page, y, x, w, text }
  for (let pi = 0; pi < n; pi++) {
    const pg = doc.loadPage(pi)
    const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
    for (const b of parsed.blocks) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const t = (ln.text || '').trim()
        if (!t) continue
        allLines.push({ page: pi, y: Math.round(ln.bbox.y), x: Math.round(ln.bbox.x),
                        w: Math.round(ln.bbox.w), text: t })
      }
    }
  }
  // Sort by page, then y, then x
  allLines.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)

  // Find anchors: either (a) line is just "N" with x < 60, w < 22
  //   or (b) line starts with "N " where 1 <= N <= 120, x < 60, N is sequential
  const anchors = []
  for (let i = 0; i < allLines.length; i++) {
    const ln = allLines[i]
    if (ln.x > 60) continue
    if (/代號|頁次|等別|類科|科目|座號/.test(ln.text)) continue
    let num = null
    const pure = ln.text.match(/^(\d{1,3})$/)
    const inline = ln.text.match(/^(\d{1,3})\s+(.+)/)
    if (pure && ln.w < 22) num = +pure[1]
    else if (inline) num = +inline[1]
    if (num == null || num < 1 || num > 120) continue
    const prev = anchors[anchors.length - 1]
    if (prev && (ln.page < prev.page || (ln.page === prev.page && ln.y <= prev.y))) continue
    // must be sequential from previous (or n <= 3 for start)
    if (prev) { if (num !== prev.num + 1) continue }
    else { if (num > 3) continue }
    anchors.push({ num, page: ln.page, y: ln.y, x: ln.x, idx: i, inline: !!inline })
  }

  const out = {}
  for (let ai = 0; ai < anchors.length; ai++) {
    const a = anchors[ai]
    const next = anchors[ai + 1]
    const regionLines = allLines.filter(ln => {
      if (ln.page < a.page) return false
      if (ln.page === a.page && ln.y < a.y) return false
      if (next) {
        if (ln.page > next.page) return false
        if (ln.page === next.page && ln.y >= next.y) return false
      }
      return true
    })
    // content = lines at x > 55 (right of number column)
    const content = regionLines.filter(ln => ln.x > 55 || (ln.idx === a.idx && a.inline))
    if (!content.length) continue

    // Group lines by y (same row if y diff <= 3)
    const rows = []
    for (const ln of content) {
      const last = rows[rows.length - 1]
      if (last && last.page === ln.page && Math.abs(last.y - ln.y) <= 3) last.parts.push(ln)
      else rows.push({ page: ln.page, y: ln.y, parts: [ln] })
    }
    for (const r of rows) r.parts.sort((a, b) => a.x - b.x)

    // Remove the leading "N " from the first row if inline
    if (a.inline && rows.length > 0) {
      const first = rows[0].parts[0]
      first.text = first.text.replace(/^\d{1,3}\s+/, '')
    }

    // Identify option rows: those with >=2 parts OR single-part at x > 120 (right column)
    const isMultiCol = r => r.parts.length >= 2 && r.parts.some(p => p.x > 120)
    const firstOptIdx = rows.findIndex(isMultiCol)
    if (firstOptIdx < 0) continue

    const questionRows = rows.slice(0, firstOptIdx)
    const optionRows = rows.slice(firstOptIdx)

    // Collect option parts from option rows, split into left (x < 200) / right (x >= 200) columns
    const leftParts = [], rightParts = []
    for (const r of optionRows) {
      for (const p of r.parts) {
        if (p.x < 200) leftParts.push(p)
        else rightParts.push(p)
      }
    }
    if (leftParts.length < 2 || rightParts.length < 2) continue
    // Sort by y
    leftParts.sort((a, b) => a.page - b.page || a.y - b.y)
    rightParts.sort((a, b) => a.page - b.page || a.y - b.y)
    // Merge wrap continuations: if a part is indented (x > first part's x + 5), merge with previous
    function mergeWraps(parts) {
      if (!parts.length) return []
      const baseX = parts[0].x
      const result = [{ ...parts[0] }]
      for (let i = 1; i < parts.length; i++) {
        if (parts[i].x > baseX + 5) result[result.length-1].text += parts[i].text
        else result.push({ ...parts[i] })
      }
      return result
    }
    const leftOpts = mergeWraps(leftParts)
    const rightOpts = mergeWraps(rightParts)
    if (leftOpts.length < 2 || rightOpts.length < 2) continue
    const A = leftOpts[0].text.trim()
    const B = rightOpts[0].text.trim()
    const C = leftOpts[1].text.trim()
    const D = rightOpts[1].text.trim()
    const question = questionRows.map(r => r.parts.map(p => p.text).join('')).join('').trim()
    if (!question || !A || !B || !C || !D) continue
    out[a.num] = { question, options: { A, B, C, D } }
  }
  return out
}

// Fallback parser for PDFs where findAnchors fails (number embedded inline).
// Uses raw pdfParse text and splits on sequential number boundaries.
async function parseQuestionsTextFallback(buf) {
  const { text } = await pdfParse(buf)
  // Skip header, find start of question area. Signal: first line starting with "1 " after the instructions
  const lines = text.replace(/\r\n/g, '\n').split('\n').map(s => s.replace(/\s+$/,'')).filter(s => s.trim())
  const out = {}
  // Find anchor lines: start with NN followed by space+Chinese or space+alpha
  const anchors = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\d{1,3})\s+(.{2,})$/)
    if (!m) continue
    const n = parseInt(m[1])
    if (n < 1 || n > 120) continue
    // must start with CJK or alpha, not another digit (avoid "60%" etc)
    if (!/^[\u4e00-\u9fff A-Za-z①②③④⑤⑥⑦⑧⑨（(【［]/.test(m[2].trim().charAt(0))) continue
    // skip lines like "代號：1106"
    if (/代號|頁次|等別|類科|科目|座號/.test(lines[i])) continue
    anchors.push({ i, n, firstLine: m[2] })
  }
  // Keep only anchors that are sequential (n == prev+1) or first anchor at n===1
  const kept = []
  for (const a of anchors) {
    const prev = kept[kept.length - 1]
    if (!prev) { if (a.n === 1 || a.n <= 5) kept.push(a); continue }
    if (a.n === prev.n + 1) kept.push(a)
    // skip non-sequential
  }
  for (let k = 0; k < kept.length; k++) {
    const a = kept[k]
    const endI = k + 1 < kept.length ? kept[k+1].i : Math.min(a.i + 20, lines.length)
    const block = [a.firstLine]
    for (let j = a.i + 1; j < endI; j++) {
      if (/代號|頁次/.test(lines[j])) continue
      block.push(lines[j])
    }
    // Heuristic split: question = everything before option line; options = last 1-2 lines
    // Option detection: line with 4 segments separated by 2+ spaces, OR 2 lines of "opt1 opt2"
    let optLines = []
    let qLines = block.slice()
    // Try last line with 4 whitespace-separated chunks
    const splitToN = (s, n) => {
      const parts = s.split(/\s{2,}/).filter(Boolean)
      if (parts.length === n) return parts
      return null
    }
    const last = block[block.length-1]
    let fourOpts = splitToN(last, 4)
    if (fourOpts) { optLines = [last]; qLines = block.slice(0, -1) }
    else if (block.length >= 2) {
      // Try last 2 lines, each 2 options
      const l2 = block[block.length-2]
      const p1 = splitToN(l2, 2), p2 = splitToN(last, 2)
      if (p1 && p2) { fourOpts = [...p1, ...p2]; optLines = [l2, last]; qLines = block.slice(0, -2) }
    }
    if (!fourOpts) {
      // Try splitting last line(s) on single space — last resort, only for pure-alpha options
      const tryPure = last.trim().split(/\s+/)
      if (tryPure.length === 4 && tryPure.every(w => /^[A-Za-z][A-Za-z0-9]*$/.test(w))) {
        fourOpts = tryPure; optLines = [last]; qLines = block.slice(0, -1)
      }
    }
    if (!fourOpts) continue  // give up, let other parser handle
    const question = qLines.join(' ').replace(/\s+/g, ' ').trim()
    if (!question) continue
    out[a.n] = { question, options: { A: fourOpts[0].trim(), B: fourOpts[1].trim(), C: fourOpts[2].trim(), D: fourOpts[3].trim() } }
  }
  return out
}

// ─── Fix targets: nursing contamination + encoding issues ───
// Grouped by (code, c, s, subject) for batch-fetching one PDF per paper
const NURSING_FIXES = [
  { code: '106030', s: '0502', subject: '基本護理學與護理行政', nums: [6] },
  { code: '107030', s: '0502', subject: '基本護理學與護理行政', nums: [4, 46] },
  { code: '108020', s: '0501', subject: '基礎醫學',              nums: [60, 61, 66, 72] },
  { code: '108020', s: '0502', subject: '基本護理學與護理行政', nums: [26] },
  { code: '108020', s: '0503', subject: '內外科護理學',          nums: [19] },
  { code: '108110', s: '0502', subject: '基本護理學與護理行政', nums: [3, 23, 49, 68] },
]

// tcm2 108110 subject codes per CLAUDE.md / existing config
// 108110 c=102 s=0103 = 中醫臨床醫學(一) per MISSING-BROWSER-SEARCH
const TCM2_FIXES = [
  { code: '108110', c: '102', s: '0103', subject: '中醫臨床醫學(一)',
    tag: 'tcm_clinical_1', year: '108', session: '第二次', nums: [33] },
]

// customs 110050 c=101 s=0308 = 法學知識
const CUSTOMS_FIXES = [
  { code: '110050', c: '101', s: '0308', subject: '法學知識',
    tag: 'law_knowledge', year: '110', session: '關務特考', nums: [8, 31, 34, 36, 40] },
]

async function fetchAndParse(prefix, code, c, s) {
  let qBuf, aBuf
  try { qBuf = await cachedPdf(prefix, 'Q', code, c, s) } catch (e) { return { err: 'Q:' + e.message } }
  try { aBuf = await cachedPdf(prefix, 'S', code, c, s) } catch (e) { /* ignore, try M or nothing */ }
  let parsed, answers = {}
  try { parsed = await parseQuestionsColumnAware(qBuf, false) } catch (e) { parsed = {} }
  // Merge relaxed mupdf parser for anchor-missed numbers
  try {
    const relaxed = await parseQuestionsMupdfRelaxed(qBuf)
    for (const [k, v] of Object.entries(relaxed)) {
      if (!parsed[k]) parsed[k] = v
    }
  } catch (e) {}
  // Last-resort text fallback
  try {
    const fallback = await parseQuestionsTextFallback(qBuf)
    for (const [k, v] of Object.entries(fallback)) {
      if (!parsed[k]) parsed[k] = v
    }
  } catch {}
  if (aBuf) {
    try { answers = await parseAnswersColumnAware(aBuf) } catch {}
    if (!Object.keys(answers).length) {
      try { answers = await parseAnswersPdfParse(aBuf) } catch {}
    }
  }
  return { parsed, answers }
}

function applyToFile(file, updates) {
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
  let nextId = Math.max(...data.questions.map(q => q.id || 0)) + 1
  let replaced = 0, added = 0, missed = 0
  const missedList = []
  for (const u of updates) {
    const idx = data.questions.findIndex(q =>
      q.exam_code === u.exam_code && q.subject === u.subject && q.number === u.number)
    if (!u.question || !u.options || !u.answer) { missed++; missedList.push(u); continue }
    if (idx >= 0) {
      const existing = data.questions[idx]
      data.questions[idx] = { ...existing, ...u }
      replaced++
    } else {
      data.questions.push({ id: nextId++, ...u })
      added++
    }
  }
  data.total = data.questions.length
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
  return { replaced, added, missed, missedList }
}

async function runNursing(dryRun) {
  console.log('\n=== 1. Nursing contamination fix ===')
  const updates = []
  const markIncomplete = []  // {exam_code, subject, number} for entries we can't reparse
  const data = JSON.parse(fs.readFileSync(path.join(__dirname,'..','questions-nursing.json'),'utf-8'))
  for (const fx of NURSING_FIXES) {
    const { err, parsed, answers } = await fetchAndParse('nursing_fix', fx.code, '106', fx.s)
    if (err) { console.log(`  ✗ ${fx.code} ${fx.subject}: ${err}`); continue }
    const pCount = parsed ? Object.keys(parsed).length : 0
    const aCount = Object.keys(answers).length
    console.log(`  ${fx.code} ${fx.subject}: ${pCount}Q/${aCount}A`)
    for (const n of fx.nums) {
      const p = parsed && parsed[n]
      const a = answers[n]
      if (!p || !a) {
        console.log(`    ⚠ Q${n}: reparse failed — marking incomplete`)
        markIncomplete.push({ exam_code: fx.code, subject: fx.subject, number: n })
        continue
      }
      const sample = data.questions.find(q => q.subject === fx.subject)
      updates.push({
        roc_year: fx.code.slice(0,3),
        session: fx.code === '108020' || fx.code === '106030' || fx.code === '107030' ? '第一次' : '第二次',
        exam_code: fx.code,
        subject: fx.subject, subject_tag: sample?.subject_tag || '', subject_name: fx.subject,
        stage_id: 0, number: n,
        question: p.question, options: p.options, answer: a, explanation: '',
      })
      console.log(`    ✓ Q${n}: ${p.question.slice(0,30)}...`)
    }
  }
  if (dryRun) {
    console.log(`  [dry-run] ${updates.length} replacements, ${markIncomplete.length} to mark incomplete`)
    return
  }
  // Apply replacements
  if (updates.length) {
    const r = applyToFile(path.join(__dirname,'..','questions-nursing.json'), updates)
    console.log(`  ✅ replace: ${r.replaced} replaced, ${r.added} added, ${r.missed} missed`)
  }
  // Mark incomplete for unparseable contaminations
  if (markIncomplete.length) {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname,'..','questions-nursing.json'),'utf-8'))
    let marked = 0
    for (const m of markIncomplete) {
      const q = d.questions.find(x => x.exam_code===m.exam_code && x.subject===m.subject && x.number===m.number)
      if (q) { q.incomplete = true; q.gap_reason = 'tcm_contamination_pending_reparse'; marked++ }
    }
    const file = path.join(__dirname,'..','questions-nursing.json')
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2))
    fs.renameSync(tmp, file)
    console.log(`  ⚠ marked ${marked} contamination entries as incomplete (pending reparse)`)
  }
}

async function runTargeted(label, file, fixes, dryRun) {
  console.log(`\n=== ${label} ===`)
  const updates = []
  for (const fx of fixes) {
    const { err, parsed, answers } = await fetchAndParse(label, fx.code, fx.c, fx.s)
    if (err) { console.log(`  ✗ ${fx.code} ${fx.subject}: ${err}`); continue }
    const pCount = parsed ? Object.keys(parsed).length : 0
    const aCount = Object.keys(answers).length
    console.log(`  ${fx.code} ${fx.subject}: ${pCount}Q/${aCount}A`)
    for (const n of fx.nums) {
      const p = parsed && parsed[n]
      const a = answers[n]
      if (!p || !a) { console.log(`    ✗ Q${n}: p=${!!p}, a=${a||'?'}`); continue }
      updates.push({
        roc_year: fx.year, session: fx.session, exam_code: fx.code,
        subject: fx.subject, subject_tag: fx.tag, subject_name: fx.subject,
        stage_id: 0, number: n,
        question: p.question, options: p.options, answer: a, explanation: '',
      })
      console.log(`    ✓ Q${n}: ${p.question.slice(0,30)}...`)
    }
  }
  if (dryRun || !updates.length) { console.log(`  [dry-run or nothing] ${updates.length} updates prepared`); return }
  const r = applyToFile(file, updates)
  console.log(`  ✅ ${label}: ${r.replaced} replaced, ${r.added} added, ${r.missed} missed`)
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  await runNursing(dryRun)
  await runTargeted('tcm2', path.join(__dirname,'..','questions-tcm2.json'), TCM2_FIXES, dryRun)
  await runTargeted('customs', path.join(__dirname,'..','questions-customs.json'), CUSTOMS_FIXES, dryRun)
}

main().catch(e => { console.error(e); process.exit(1) })
