#!/usr/bin/env node
// Inspect raw PDF text for 8 edge-case questions
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

// (label, candidate PDF files, q#)
const cases = [
  ['doctor1 100030 醫學(二) #22', ['Q_100030_c101_s0102.pdf'], 22],
  ['tcm1 106110 中基(一) #57', ['Q_106110_c101_s0101.pdf','Q_106110_c101_s0102.pdf','tcm1_Q_106110_c101_s0101.pdf','tcm1_Q_106110_c101_s0102.pdf'], 57],
  ['tcm1 108110 中基(一) #73', ['Q_108110_c101_s0101.pdf','Q_108110_c101_s0102.pdf','tcm1_Q_108110_c101_s0101.pdf','tcm1_Q_108110_c101_s0102.pdf'], 73],
  ['tcm2 107110 中臨(一) #58', ['Q_107110_c102_s0103.pdf','tcm2_Q_107110_c102_s0103.pdf'], 58],
  ['nursing 109030 精神社區 #21', ['Q_109030_c106_s0505.pdf','nursing_Q_109030_c106_s0505.pdf'], 21],
  ['nutrition 108110 生理生化 #35', ['Q_108110_c103_s0201.pdf','nutrition_Q_108110_c103_s0201.pdf'], 35],
  ['nutrition 109030 團膳 #21', ['Q_109030_c103_s0204.pdf','nutrition_Q_109030_c103_s0204.pdf'], 21],
  ['medlab 100030 血清病毒 #49', ['Q_100030_c104_s0107.pdf'], 49],
]

async function main() {
  for (const [label, files, num] of cases) {
    console.log('\n======== ' + label)
    for (const f of files) {
      const fp = path.join(PDF_CACHE, f)
      if (!fs.existsSync(fp)) continue
      const buf = fs.readFileSync(fp)
      const txt = await readText(buf)
      const re = new RegExp(`\\n\\s*${num}[\\.\\s]([\\s\\S]+?)\\n\\s*${num + 1}[\\.\\s]`)
      const m = txt.match(re)
      if (!m) { console.log('  ' + f + ' → no match'); continue }
      console.log('  ' + f)
      console.log('  ----')
      console.log(m[1].slice(0, 600).split('\n').map(l => '  | ' + l).join('\n'))
      break
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
