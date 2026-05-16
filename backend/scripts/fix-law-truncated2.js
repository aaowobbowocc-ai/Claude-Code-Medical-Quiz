#!/usr/bin/env node
// Re-extract truncated 公職 questions using user-provided MoEX PDFs.
// Standard 4-option re-extraction (question = lines before last 4, options =
// last 4 non-blank lines). For multichoice (①②③④ in question) the last 4
// lines are combo codes instead.
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

// (file, year) → PDF filename
const PDF = {
  'common_admin_studies|113': 'userpdf_113080_c301_s0303.pdf',
  'common_admin_studies|107': 'userpdf_107090_c301_s0607.pdf',
  'common_admin_studies|106': 'userpdf_106090_c201_s0504.pdf',
  'common_admin_law_junior|110': 'userpdf_110090_c401_s0606.pdf',
  'common_admin_law_junior|111': 'userpdf_111090_c401_s0406.pdf',
  'common_admin_studies_junior|108': 'userpdf_108090_c401_s0608.pdf',
  'common_law_knowledge|106': 'userpdf_106090_c401_s0211.pdf',
}
// civil-senior.json 行政學 mirrors
const EXAM_PDF = {
  '113080': 'userpdf_113080_c301_s0303.pdf',
  '107090': 'userpdf_107090_c301_s0607.pdf',
}

function parseQ(txt, num) {
  const re = new RegExp('\\n\\s*' + num + '\\s*\\n([\\s\\S]+?)\\n\\s*' + (num + 1) + '\\s*\\n(?=[一-鿿])')
  const m = txt.match(re)
  if (!m) return null
  const lines = m[1].split(/\n+/).map(s => s.trim())
    .filter(s => s.length > 0 && !/^代號|^頁次/.test(s))
  if (lines.length < 5) return null
  const opts = lines.slice(-4)
  const question = lines.slice(0, -4).join(' ').replace(/\s+/g, ' ').trim()
  if (question.length < 8 || opts.some(o => o.length < 1)) return null
  return { question, options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] } }
}

const norm = s => (s || '').replace(/[^一-鿿A-Za-z0-9]/g, '')

async function main() {
  const APPLY = process.argv.includes('--apply')
  const textCache = {}
  async function getText(file) {
    if (textCache[file] === undefined) {
      try { textCache[file] = await readText(fs.readFileSync(path.join(PDF_CACHE, file))) }
      catch { textCache[file] = null }
    }
    return textCache[file]
  }
  let total = 0, fail = 0
  // shared-banks
  for (const [key, pdf] of Object.entries(PDF)) {
    const [bank] = key.split('|')
    const fp = 'shared-banks/' + bank + '.json'
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    const arr = data.questions || data
    const txt = await getText(pdf)
    if (!txt) { console.log('no PDF text', pdf); continue }
    let n = 0
    for (const q of arr) {
      if (q.incomplete !== 'truncated_options') continue
      if (`${bank}|${q.roc_year}` !== key) continue
      const p = parseQ(txt, q.number)
      if (!p) { fail++; console.log('  ✗', q.id, '#' + q.number); continue }
      if (norm(p.question).slice(0, 8) !== norm(q.question).slice(0, 8)) {
        fail++; console.log('  ✗ mismatch', q.id, '|', norm(p.question).slice(0,12), 'vs', norm(q.question).slice(0,12)); continue
      }
      if (APPLY) { q.question = p.question; q.options = p.options; delete q.incomplete }
      n++; total++
    }
    if (n > 0) { if (APPLY) fs.writeFileSync(fp, JSON.stringify(data, null, 2)); console.log(fp, ':', n) }
  }
  // civil-senior.json mirrors
  const csData = JSON.parse(fs.readFileSync('questions-civil-senior.json', 'utf-8'))
  const csArr = csData.questions || csData
  let csN = 0
  for (const q of csArr) {
    if (q.incomplete !== 'truncated_options') continue
    const pdf = EXAM_PDF[q.exam_code]
    if (!pdf) continue
    const txt = await getText(pdf)
    if (!txt) continue
    const p = parseQ(txt, q.number)
    if (!p) { fail++; continue }
    if (norm(p.question).slice(0, 8) !== norm(q.question).slice(0, 8)) { fail++; continue }
    if (APPLY) { q.question = p.question; q.options = p.options; delete q.incomplete }
    csN++; total++
  }
  if (csN > 0) { if (APPLY) fs.writeFileSync('questions-civil-senior.json', JSON.stringify(csData, null, 2)); console.log('questions-civil-senior.json :', csN) }
  console.log('\nTOTAL:', total, '| fail:', fail, APPLY ? '(applied)' : '(dry-run)')
}
main().catch(e => { console.error(e); process.exit(1) })
