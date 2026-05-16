#!/usr/bin/env node
// Re-extract truncated 法學知識/法律 questions from cached MoEX PDFs.
// Targets shared-bank entries (incomplete='truncated_options') sourced from
// customs 115 / judicial 109,110, plus their mirrors in exam JSON files.
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

// PDF per (source, year)
const PDF_MAP = {
  'customs|115': 'customs_115040_c101_s0305.pdf',
  'judicial|109': 'judicial_109130_c101_s0412.pdf',
  'judicial|110': 'judicial_110130_c101_s0315.pdf',
}

// Parse question N: question text + 4 options. Options are the last 4 non-blank
// lines; everything before is the (possibly multi-line) question stem.
function parseQ(txt, num) {
  const re = new RegExp('\\n\\s*' + num + '\\s*\\n([\\s\\S]+?)\\n\\s*' + (num + 1) + '\\s*\\n')
  const m = txt.match(re)
  if (!m) return null
  const lines = m[1].split(/\n+/).map(s => s.trim())
    .filter(s => s.length > 0 && !/^代號|^頁次/.test(s))
  if (lines.length < 5) return null
  const opts = lines.slice(-4)
  const question = lines.slice(0, -4).join(' ').replace(/\s+/g, ' ').trim()
  if (question.length < 8) return null
  // Options should be substantive (法學題選項通常 >5 字)
  if (opts.some(o => o.length < 2)) return null
  return { question, options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] } }
}

async function main() {
  const APPLY = process.argv.includes('--apply')
  const textCache = {}
  async function getText(file) {
    if (textCache[file] === undefined) {
      const fp = path.join(PDF_CACHE, file)
      try { textCache[file] = await readText(fs.readFileSync(fp)) }
      catch { textCache[file] = null }
    }
    return textCache[file]
  }

  // All files to scan: shared-banks + customs/judicial exam files
  const sharedDir = 'shared-banks'
  const targets = [
    ...fs.readdirSync(sharedDir).filter(f => f.endsWith('.json') && !f.startsWith('_')).map(f => sharedDir + '/' + f),
    'questions-customs.json', 'questions-judicial.json',
  ]
  let total = 0, noMatch = 0
  for (const fp of targets) {
    if (!fs.existsSync(fp)) continue
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    const arr = data.questions || data
    let fixed = 0
    for (const q of arr) {
      if (q.incomplete !== 'truncated_options') continue
      // Determine source + year
      const src = q.source_exam_code || (fp.includes('customs') ? 'customs' : fp.includes('judicial') ? 'judicial' : null)
      const year = q.roc_year
      const key = `${src}|${year}`
      const pdfFile = PDF_MAP[key]
      if (!pdfFile) continue
      const txt = await getText(pdfFile)
      if (!txt) continue
      const parsed = parseQ(txt, q.number)
      if (!parsed) { noMatch++; continue }
      // Validate question prefix overlaps
      const norm = s => (s || '').replace(/[^一-鿿A-Za-z0-9]/g, '')
      if (norm(parsed.question).slice(0, 10) !== norm(q.question).slice(0, 10)) { noMatch++; continue }
      if (APPLY) {
        q.question = parsed.question
        q.options = parsed.options
        delete q.incomplete
      }
      fixed++
    }
    if (fixed > 0) {
      if (APPLY) fs.writeFileSync(fp, JSON.stringify(data, null, 2))
      console.log(fp, ':', fixed)
      total += fixed
    }
  }
  console.log('\nTOTAL fixed:', total, '| no match:', noMatch)
  if (!APPLY) console.log('(dry-run)')
}
main().catch(e => { console.error(e); process.exit(1) })
