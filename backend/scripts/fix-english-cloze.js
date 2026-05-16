#!/usr/bin/env node
// Fill common_english truncated reading-cloze questions. Each "請依下文回答
// 第X題至第Y題" block has a shared passage → questions X..Y get that passage
// as stem. Standalone vocab clozes get their single sentence.
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

// (source, year) → PDF
const PDF = {
  'civil-senior|109': 'userpdf_109090_c301_s0216.pdf',
  'civil-senior|110': 'userpdf_110090_c301_s0105.pdf',
  'civil-senior|111': 'userpdf_111090_c301_s0115.pdf',
  'civil-senior|112': 'userpdf_112090_c301_s0118.pdf',
  'civil-senior|114': 'userpdf_114080_c201_s0401.pdf',
  'judicial|109': 'judicial_109130_c101_s0412.pdf',
  'judicial|110': 'judicial_110130_c101_s0315.pdf',
}

// Build number→stem map for one PDF's English section
function buildStems(txt) {
  const stems = {}
  // Passage blocks
  const passRe = /請依下文回答第\s*(\d+)\s*題至第\s*(\d+)\s*題[:：]?\s*([\s\S]+?)(?=請依下文回答|\n\s*乙、|$)/g
  let pm
  while ((pm = passRe.exec(txt)) !== null) {
    const start = parseInt(pm[1]), end = parseInt(pm[2])
    // Cut the trailing per-question option list: first standalone number line
    // followed by 4 short word-lines (the options block, not a passage blank).
    const bl = pm[3].split(/\n+/).map(s => s.trim())
    let cut = bl.length
    for (let i = 0; i < bl.length - 4; i++) {
      if (!/^\d{1,2}$/.test(bl[i])) continue
      const n4 = bl.slice(i + 1, i + 5)
      if (n4.every(l => l && l.length <= 22 && l.split(/\s+/).length <= 3 && !/[。，]/.test(l))) {
        cut = i; break
      }
    }
    const passage = bl.slice(0, cut).join(' ').replace(/\s+/g, ' ').trim()
    if (passage.length < 30) continue
    for (let n = start; n <= end; n++) {
      stems[n] = { question: `（英文閱讀測驗）${passage}` }
    }
    // Parse the trailing option-list: "N\n<A>\n<B>\n<C>\n<D>\n(N+1)\n..."
    for (let i = cut; i < bl.length - 4; i++) {
      const n = parseInt(bl[i])
      if (!/^\d{1,2}$/.test(bl[i]) || n < start || n > end) continue
      const o = bl.slice(i + 1, i + 5).filter(l => l && l.length <= 30)
      if (o.length === 4 && stems[n]) stems[n].options = { A: o[0], B: o[1], C: o[2], D: o[3] }
    }
  }
  return stems
}

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
  const stemCache = {}
  async function stemsFor(key) {
    if (stemCache[key] === undefined) {
      const pdf = PDF[key]
      const txt = pdf ? await getText(pdf) : null
      stemCache[key] = txt ? buildStems(txt) : {}
    }
    return stemCache[key]
  }

  const fp = 'shared-banks/common_english.json'
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data
  let fixed = 0, miss = 0
  for (const q of arr) {
    if (q.incomplete !== 'truncated_options' && q.incomplete !== 'short_question') continue
    const src = q.source_exam_code
    const key = `${src}|${q.roc_year}`
    const stems = await stemsFor(key)
    const stem = stems[q.number]
    if (!stem) { miss++; continue }
    if (APPLY) {
      q.question = stem.question
      // Only overwrite options if PDF gave a clean 4-set; else keep existing
      if (stem.options && Object.values(stem.options).every(v => v && v.length >= 1)) {
        q.options = stem.options
      }
      delete q.incomplete
    }
    fixed++
    if (fixed <= 3) console.log(`  ${q.id}: ${stem.question.slice(0, 60)}... opts=${stem.options ? 'Y' : 'N'}`)
  }
  if (APPLY) fs.writeFileSync(fp, JSON.stringify(data, null, 2))
  console.log('fixed:', fixed, '| miss:', miss, APPLY ? '(applied)' : '(dry-run)')
}
main().catch(e => { console.error(e); process.exit(1) })
