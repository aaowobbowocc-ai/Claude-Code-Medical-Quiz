#!/usr/bin/env node
// Re-extract standalone vocabulary-cloze English questions: "N\n<sentence with
// blank>\n<optA>\n<optB>\n<optC>\n<optD>\n(N+1)". Targets common_english +
// customs/police4 英文 incomplete entries that have a cached PDF.
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

// (source, year) → PDF for common_english
const CE_PDF = {
  'civil-senior|112': 'userpdf_112090_c301_s0118.pdf',
  'civil-senior|114': 'userpdf_114080_c201_s0401.pdf',
  'judicial|109': 'judicial_109130_c101_s0412.pdf',
  'judicial|114': 'judicial_114120_c101_s0309.pdf',
}

// Extract question N as vocab cloze: sentence + 4 options.
function parseVocab(txt, num) {
  const re = new RegExp('\n\s*' + num + '\s*\n([\s\S]+?)\n\s*' + (num + 1) + '\s*\n')
  const m = txt.match(re)
  if (!m) return null
  const lines = m[1].split(/\n+/).map(s => s.trim())
    .filter(s => s.length > 0 && !/^代號|^頁次/.test(s))
  if (lines.length < 5) return null
  const opts = lines.slice(-4)
  const question = lines.slice(0, -4).join(' ').replace(/\s+/g, ' ').trim()
  // Vocab cloze sanity: question has a blank, options are short
  if (question.length < 15) return null
  if (opts.some(o => o.length < 1 || o.length > 40)) return null
  return { question, options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] } }
}

const norm = s => (s || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase()

async function main() {
  const APPLY = process.argv.includes('--apply')
  const tc = {}
  async function getText(f) {
    if (tc[f] === undefined) {
      try { tc[f] = await readText(fs.readFileSync(path.join(PDF_CACHE, f))) }
      catch { tc[f] = null }
    }
    return tc[f]
  }

  let total = 0, miss = 0
  // common_english
  const fp = 'shared-banks/common_english.json'
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data
  for (const q of arr) {
    if (!['short_question', 'empty_question', 'truncated_options'].includes(q.incomplete)) continue
    const pdf = CE_PDF[`${q.source_exam_code}|${q.roc_year}`]
    if (!pdf) { miss++; continue }
    const txt = await getText(pdf)
    if (!txt) { miss++; continue }
    const p = parseVocab(txt, q.number)
    if (!p) { miss++; continue }
    // Validate: an existing option should appear among parsed options
    const existing = Object.values(q.options || {}).map(norm).filter(Boolean)
    const parsedOpts = Object.values(p.options).map(norm)
    const overlap = existing.filter(e => parsedOpts.includes(e)).length
    if (existing.length >= 2 && overlap < 1) { miss++; continue }
    if (APPLY) { q.question = p.question; q.options = p.options; delete q.incomplete }
    total++
    if (total <= 4) console.log(`  ${q.id}: ${p.question.slice(0, 55)} | ${JSON.stringify(p.options)}`)
  }
  if (APPLY) fs.writeFileSync(fp, JSON.stringify(data, null, 2))
  console.log('common_english fixed:', total, '| miss:', miss, APPLY ? '(applied)' : '(dry-run)')
}
main().catch(e => { console.error(e); process.exit(1) })
