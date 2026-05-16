#!/usr/bin/env node
// Full re-extraction for multichoice questions whose STEM is also truncated
// (statements leaked into options A/B, so the DB question text is incomplete).
// Anchor on the clean stem prefix (text before the first ①), then rebuild
// both question (stem + statements) and the 4 combo options from the PDF.
const fs = require('fs')
const path = require('path')
const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }
async function readText(buf) {
  const mupdf = await getMupdf()
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) txt += doc.loadPage(i).toStructuredText('preserve-whitespace').asText()
  return txt.normalize('NFKC')
}

const CIRC = '①②③④⑤⑥⑦⑧⑨⑩'
const toCircled = s => s.replace(/[0-9]/g, d => CIRC[parseInt(d) - 1] || d)
// Normalize for fuzzy matching: map circled→digit, then KEEP ONLY CJK
// ideographs + ASCII letters/digits. Dropping ALL punctuation (both widths)
// sidesteps fullwidth/halfwidth comma mismatches between DB and PDF.
const norm = s => s
  .replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g, m => String(CIRC.indexOf(m) + 1))
  .replace(/[^A-Za-z0-9一-鿿]/g, '')
const comboChars = s => s.replace(/[^①-⑳0-9]/g, '')
// A real combo-code line, after dropping whitespace + Private-Use glyphs,
// consists ONLY of digits/circled numbers (1-8 of them). A line with any CJK
// text is NOT a combo line — earlier `comboChars().length` test wrongly passed
// stem lines that merely contained a stray digit.
const isComboLine = s => {
  const clean = s.replace(/[\s-]/g, '')
  return clean.length >= 1 && clean.length <= 8 && /^[①-⑳0-9]+$/.test(clean)
}

// Locate the question by its clean stem prefix, return {question, options}.
function reextract(txt, stemPrefix) {
  const lines = txt.split(/\n+/).map(s => s.trim())
  const aNorm = norm(stemPrefix)
  if (aNorm.length < 10) return null
  // Find the exact line where the stem begins. Stem may wrap across lines, so
  // first locate it via a sliding 4-line window, then pin the start line as
  // the one whose own text begins the stem (so we don't drag in prior lines).
  const head = aNorm.slice(0, Math.min(14, aNorm.length))
  for (let i = 0; i < lines.length; i++) {
    const win = norm(lines.slice(i, i + 4).join(''))
    if (!win.includes(head)) continue
    // Pin the real start line — the single line whose own text begins the stem
    let start = -1
    for (let s = i; s < i + 5 && s < lines.length; s++) {
      if (norm(lines[s]).startsWith(head.slice(0, 8))) { start = s; break }
    }
    if (start < 0) continue
    const collected = []
    for (let j = start; j < lines.length && j < start + 40; j++) {
      if (/^代號|^頁次/.test(lines[j])) continue
      // Look ahead: is a 4-combo run starting here?
      const combos = []
      let k = j
      while (k < lines.length && combos.length < 4) {
        const b = comboChars(lines[k])
        if (b) { if (!isComboLine(lines[k])) break; combos.push(b); k++ }
        else k++
      }
      if (combos.length === 4) {
        const question = collected.join(' ').replace(/\s+/g, ' ').trim()
        if (question.length < 12) return null
        return {
          question,
          options: {
            A: toCircled(combos[0]), B: toCircled(combos[1]),
            C: toCircled(combos[2]), D: toCircled(combos[3]),
          },
        }
      }
      collected.push(lines[j])
    }
    return null
  }
  return null
}

function isPolluted(q) {
  if (!q.options || q.incomplete) return false
  if (!/[①②③④⑤]/.test(q.question || '')) return false
  const opts = Object.values(q.options).map(v => String(v || '').trim())
  const cc = o => /^[①②③④⑤⑥⑦0-9]{1,6}$/.test(o.replace(/\s/g, ''))
  const pol = opts.filter(o => /[①②③④⑤⑥][一-鿿]{3,}/.test(o) && !cc(o))
  return pol.length > 0 && opts.filter(cc).length >= 2
}

function buildPdfIndex() {
  const idx = {}
  for (const f of fs.readdirSync(PDF_CACHE)) {
    if (!/\.pdf$/.test(f)) continue
    if (/^(A_|M_|S_|T)/.test(f)) continue
    const m = f.match(/_(\d{5,6})_c\w+_s\w+\.pdf$/)
    if (!m) continue
    if (!idx[m[1]]) idx[m[1]] = []
    idx[m[1]].push(f)
  }
  return idx
}

async function main() {
  const APPLY = process.argv.includes('--apply')
  const pdfIdx = buildPdfIndex()
  const textCache = {}
  async function getText(f) {
    if (textCache[f] !== undefined) return textCache[f]
    try { textCache[f] = await readText(fs.readFileSync(path.join(PDF_CACHE, f))) }
    catch { textCache[f] = null }
    return textCache[f]
  }

  const files = fs.readdirSync('.').filter(f => /^questions(-[\w-]+)?\.json$/.test(f))
  let total = 0, noPdf = 0, noMatch = 0
  for (const fp of files) {
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    const arr = data.questions || data
    let fixed = 0
    for (const q of arr) {
      if (!isPolluted(q)) continue
      const pdfs = pdfIdx[q.exam_code]
      if (!pdfs) { noPdf++; continue }
      // Clean stem = question text up to (not incl.) first circled number
      const stemPrefix = (q.question || '').split(/[①②③④⑤]/)[0].trim()
      if (stemPrefix.length < 10) { noMatch++; continue }
      let res = null
      for (const f of pdfs) {
        const txt = await getText(f)
        if (!txt) continue
        res = reextract(txt, stemPrefix)
        if (res) break
      }
      if (!res) { noMatch++; continue }
      // Sanity: options must be short combos
      const ov = Object.values(res.options)
      if (ov.some(v => v.length < 1 || v.length > 8)) { noMatch++; continue }
      // Question must still start with the same stem
      if (norm(res.question).slice(0, 12) !== norm(q.question).slice(0, 12)) { noMatch++; continue }
      if (APPLY) { q.question = res.question; q.options = res.options }
      fixed++
    }
    if (fixed > 0) {
      if (APPLY) fs.writeFileSync(fp, JSON.stringify(data, null, 2))
      console.log(fp, ':', fixed)
      total += fixed
    }
  }
  console.log('\nTOTAL:', total, '| no PDF:', noPdf, '| no match:', noMatch)
  if (!APPLY) console.log('(dry-run — pass --apply to write)')
}

main().catch(e => { console.error(e); process.exit(1) })
