#!/usr/bin/env node
/**
 * Fix doctor1 100-1 醫學(一) and 醫學(二) using M (correction) PDFs.
 *
 * Original scraper had a row-mapping bug for 100-Q exams: read the standard
 * answer PDF as row-major (rows[6,7,8,9] = 71-80, 61-70, 81-90, 91-100) but
 * the PDF is actually column-major (rows[6,7,8,9] = 71-80, 81-90, 61-70, 91-100).
 * Result: Q61-70 swapped with Q81-90 in JSON.
 *
 * The M (correction) PDF has clean per-question answers with `#` for special
 * grading. Per-question parsing is unambiguous; use that to overwrite JSON.
 *
 * Special grading semantics:
 *   - "一律給分"        → keep original answer + disputed:true (送分式)
 *   - "答X或Y或XY給分" → keep original answer + disputed:true (送分式)
 *   - "答X給分"          → set answer to X + disputed:true (更正式)
 */

const fs = require('fs')
const path = require('path')

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')

const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')

async function readPdf(p) {
  const mupdf = await import('mupdf')
  const buf = fs.readFileSync(p)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) txt += '\n' + doc.loadPage(i).toStructuredText('preserve-whitespace').asText()
  return stripPUA(txt)
}

function parseMPdf(txt) {
  // Find all answer letters in order; PDF lists Q1-100 in column-major across 5 columns of 20.
  // Text extraction order: Q01-20 (col 1), Q21-40 (col 2), ..., Q81-100 (col 5).
  // Each column: 20 letters, one per line.
  const ansBlock = txt.match(/答案\s*\n([\s\S]+?)(?=備\s*註|$)/)
  if (!ansBlock) return null
  // Get all single A-D-# letters that appear on their own line
  const letters = (ansBlock[1].match(/^\s*([A-D#])\s*$/gm) || []).map(s => s.trim())
  if (letters.length < 100) return null

  // Parse 備註 for special-grading classification
  const noteMatch = txt.match(/備\s*註[：:]([\s\S]+)/)
  const note = noteMatch ? noteMatch[1].replace(/\n/g, '') : ''
  const disputed = new Set()
  const corrections = {}  // qnum → letter (single-letter correction)
  // Pattern 1: 第N題一律給分 → disputed only
  for (const m of note.matchAll(/第(\d+)題一律給分/g)) {
    disputed.add(+m[1])
  }
  // Pattern 2: 第N題答X或Y...者均給分 (multi-letter) → disputed only, keep original
  for (const m of note.matchAll(/第(\d+)題答([A-D]+(?:或[A-D]+)+)(?:者均)?給分/g)) {
    disputed.add(+m[1])
  }
  // Pattern 3: 第N題答X給分 (single letter) → correction + disputed
  for (const m of note.matchAll(/第(\d+)題答([A-D])給分(?![或、])/g)) {
    corrections[+m[1]] = m[2]
    disputed.add(+m[1])
  }

  // Build final answers: replace # with correction, leave letters as-is
  const finalAns = letters.slice(0, 100).map((a, i) => {
    const qn = i + 1
    if (a === '#') {
      if (corrections[qn]) return { qn, ans: corrections[qn], disputed: true }
      // # but no single-letter correction → 一律給分 or multi-letter → keep original (caller decides)
      return { qn, ans: null, disputed: true }
    }
    return { qn, ans: a, disputed: disputed.has(qn) }
  })
  return finalAns
}

async function fixSubject(jsonFile, examCode, jsonSubject, pdfFileName) {
  const txt = await readPdf(path.join(PDF_CACHE, pdfFileName))
  const parsed = parseMPdf(txt)
  if (!parsed) { console.log(`  ❌ failed to parse ${pdfFileName}`); return }

  const filePath = path.join(BACKEND, jsonFile)
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const arr = data.questions || data
  let changed = 0, disputedSet = 0
  for (const { qn, ans, disputed } of parsed) {
    const q = arr.find(x => x.exam_code === examCode && x.subject === jsonSubject && x.number === qn)
    if (!q) continue
    if (ans && q.answer !== ans) { q.answer = ans; changed++ }
    if (disputed && !q.disputed) { q.disputed = true; disputedSet++ }
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
  console.log(`  ${jsonFile} ${examCode} ${jsonSubject}: ${changed} answers updated, ${disputedSet} disputed flagged`)
}

async function main() {
  await fixSubject('questions.json', '100030', '醫學(一)', 'TM_doctor1_100030_c101_s0101.pdf')
  await fixSubject('questions.json', '100030', '醫學(二)', 'TM_doctor1_100030_c101_s0102.pdf')
}

main().catch(e => { console.error(e); process.exit(1) })
