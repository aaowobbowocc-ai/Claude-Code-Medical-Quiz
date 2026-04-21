#!/usr/bin/env node
// Probe doctor1 111100 PDFs for question 29's image and any other anatomy
// questions that should have images.
const fs = require('fs')
const path = require('path')

const CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')

;(async () => {
  const mupdf = await import('mupdf')
  for (const f of ['doctor1_111100_c301_s11.pdf', 'doctor1_111100_c301_s22.pdf']) {
    const buf = fs.readFileSync(path.join(CACHE, f))
    console.log('\n===', f, '===')
    const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
    const n = doc.countPages()
    for (let pi = 0; pi < n; pi++) {
      const pg = doc.loadPage(pi)
      const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
      const anchors = []
      const images = []
      for (const b of parsed.blocks || []) {
        if (b.type === 'text') {
          for (const ln of (b.lines || [])) {
            const t = (ln.text || '').trim()
            const m = t.match(/^(\d{1,3})[.．、]\s*(.*)/)
            if (m) {
              const num = +m[1]
              if (num >= 1 && num <= 120 && m[2] && m[2].length >= 2) {
                anchors.push({ num, y: Math.round(ln.bbox.y), x: Math.round(ln.bbox.x), txt: t.slice(0, 40) })
              }
            }
          }
        } else if (b.type === 'image') {
          images.push({ y: Math.round(b.bbox.y), x: Math.round(b.bbox.x), w: Math.round(b.bbox.w), h: Math.round(b.bbox.h) })
        }
      }
      // Find anchors near 28, 29, 30
      const near = anchors.filter(a => a.num >= 27 && a.num <= 32)
      if (near.length || images.length) {
        console.log(`p${pi}: ${anchors.length} anchors, ${images.length} images`)
        for (const a of near) console.log(`  anchor ${a.num} y${a.y} x${a.x}: ${a.txt}`)
        for (const im of images) console.log(`  IMAGE y${im.y} x${im.x} ${im.w}x${im.h}`)
      }
    }
  }
})().catch(e => { console.error(e); process.exit(1) })
