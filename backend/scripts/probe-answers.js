#!/usr/bin/env node
// Reuse scraper's answer parsers to get the 10 missing answers.
const fs = require('fs')
const path = require('path')
const scraper = require('./scrape-nursing-nutrition-missing.js')

const CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')

const TARGETS = [
  { code: '110030', c: '104', s: '0301', n: 65 },
  { code: '110110', c: '104', s: '0302', n: 22 },
  { code: '110110', c: '104', s: '0303', n: 51 },
  { code: '110110', c: '104', s: '0305', n: 34 },
  { code: '112110', c: '102', s: '0201', n: 25 },
  { code: '114100', c: '102', s: '0201', n: 8 },
  { code: '114100', c: '102', s: '0202', n: 3 },
  { code: '114100', c: '102', s: '0203', n: 40 },
  { code: '114100', c: '102', s: '0204', n: 43 },
  { code: '114100', c: '102', s: '0205', n: 19 },
]

async function pdfLines(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const nPages = doc.countPages()
  const lines = []
  for (let pi = 0; pi < nPages; pi++) {
    const pg = doc.loadPage(pi)
    const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
    for (const b of parsed.blocks || []) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const t = (ln.text || '').trim()
        if (!t) continue
        lines.push({
          pi,
          y: pi * 10000 + Math.round(ln.bbox.y),
          ly: Math.round(ln.bbox.y),
          x: Math.round(ln.bbox.x),
          w: Math.round(ln.bbox.w || 0),
          text: ln.text,
        })
      }
    }
  }
  lines.sort((a, b) => a.y - b.y || a.x - b.x)
  return lines
}

;(async () => {
  for (const t of TARGETS) {
    const file = path.join(CACHE, `nursing_S_${t.code}_c${t.c}_s${t.s}.pdf`)
    if (!fs.existsSync(file)) { console.log('NO S PDF:', file); continue }
    const buf = fs.readFileSync(file)
    const lines = await pdfLines(buf)
    // Dump full text of S PDF, compact
    const full = lines.map(l => l.text).join('\n')
    // Find context around target number
    console.log(`\n=== S ${t.code}/${t.s} (target #${t.n}) ===`)
    // Try to locate "第N題" or full-width letter list
    // First: dump complete text (short PDFs are fine)
    console.log(full.slice(0, 2000))
    console.log('---')
  }
})().catch(e => { console.error(e); process.exit(1) })
