#!/usr/bin/env node
// Re-extract multichoice questions where ①②③④⑤⑥ statements leaked into options.
// The question stem is already correct (statements intact) — only the 4 combo
// options are scrambled. We locate the question's combo block in the PDF by
// finding 4 consecutive combo-code lines whose preceding text matches the stem.
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
// digit string → circled (e.g. "134" → "①③④")
const toCircled = s => s.replace(/[0-9]/g, d => CIRC[parseInt(d) - 1] || d)

function extractOptions(txt, anchorText) {
  // norm: fullwidth→halfwidth, circled→digit, keep only ASCII-visible + CJK
  const norm = s => s
    .replace(/[（）]/g, m => (m === '（' ? '(' : ')'))
    .replace(/？/g, '?')
    .replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g, m => String(CIRC.indexOf(m) + 1))
    .replace(/[^!-~　-鿿]/g, '')
  const comboChars = s => s.replace(/[^①-⑳0-9]/g, '')
  const isComboLine = s => {
    const b = comboChars(s)
    return b.length >= 1 && b.length <= 7
  }
  const lines = txt.split(/\n+/).map(s => s.trim())
  const aNorm = norm(anchorText)
  if (aNorm.length < 8) return null
  const aTail = aNorm.slice(-Math.min(24, aNorm.length))
  for (let i = 0; i < lines.length; i++) {
    if (!isComboLine(lines[i])) continue
    const combos = []
    let j = i
    while (j < lines.length && combos.length < 4) {
      const b = comboChars(lines[j])
      if (b) {
        if (!isComboLine(lines[j])) break
        combos.push(b)
        j++
      } else { j++ } // blank / Private-Use separator line
    }
    if (combos.length !== 4) continue
    const before = norm(lines.slice(Math.max(0, i - 16), i).join(''))
    if (before.includes(aTail)) {
      // Normalize each combo to circled form for DB consistency
      return {
        A: toCircled(combos[0]), B: toCircled(combos[1]),
        C: toCircled(combos[2]), D: toCircled(combos[3]),
      }
    }
  }
  return null
}

function isPolluted(q) {
  if (!q.options || q.incomplete) return false
  if (!/[①②③④⑤]/.test(q.question || '')) return false
  const opts = Object.values(q.options).map(v => String(v || '').trim())
  const cleanCombo = o => /^[①②③④⑤⑥⑦0-9]{1,6}$/.test(o.replace(/\s/g, ''))
  const cleanCount = opts.filter(cleanCombo).length
  const pol = opts.filter(o => {
    const segs = o.match(/[①②③④⑤][^①②③④⑤]{3,}/g)
    return segs && segs.length >= 2
  })
  return pol.length > 0 && cleanCount >= 1
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
  let totalFixed = 0, totalSkipNoPdf = 0, totalNoMatch = 0
  for (const fp of files) {
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    const arr = data.questions || data
    let fixed = 0
    for (const q of arr) {
      if (!isPolluted(q)) continue
      const pdfs = pdfIdx[q.exam_code]
      if (!pdfs) { totalSkipNoPdf++; continue }
      const stem = (q.question || '').replace(/\s+/g, '')
      if (stem.length < 16) { totalNoMatch++; continue }
      const anchor = stem.slice(-24)
      let opts = null
      for (const f of pdfs) {
        const txt = await getText(f)
        if (!txt) continue
        opts = extractOptions(txt, anchor)
        if (opts) break
      }
      if (!opts) { totalNoMatch++; continue }
      const vals = Object.values(opts)
      if (vals.some(v => v.length < 1 || v.length > 7)) { totalNoMatch++; continue }
      if (APPLY) q.options = opts // keep q.question — it's already correct
      fixed++
    }
    if (fixed > 0) {
      if (APPLY) fs.writeFileSync(fp, JSON.stringify(data, null, 2))
      console.log(fp, ':', fixed)
      totalFixed += fixed
    }
  }
  console.log('\nTOTAL fixable:', totalFixed, '| skip(no PDF):', totalSkipNoPdf, '| no match:', totalNoMatch)
  if (!APPLY) console.log('(dry-run — pass --apply to write)')
}

main().catch(e => { console.error(e); process.exit(1) })
