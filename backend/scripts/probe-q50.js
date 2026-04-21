#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

;(async () => {
  const buf = fs.readFileSync(path.join(__dirname, '..', '_tmp', 'pdf-cache', 'nutrition_Q_113100_c101_s0105.pdf'))
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const nP = doc.countPages()
  const lines = []
  for (let pi = 0; pi < nP; pi++) {
    const pg = doc.loadPage(pi)
    const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
    for (const b of parsed.blocks || []) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const t = (ln.text || '').trim()
        if (!t) continue
        lines.push({ pi, y: pi * 10000 + Math.round(ln.bbox.y), ly: Math.round(ln.bbox.y), x: Math.round(ln.bbox.x), text: ln.text })
      }
    }
  }
  lines.sort((a, b) => a.y - b.y || a.x - b.x)
  // Find anchors for #49 and #50
  const is = (ln, n) => {
    if (ln.x > 100) return false
    const tx = ln.text.trim()
    if (tx === String(n)) return true
    const m = tx.match(/^(\d{1,3})\s*[.．、]?\s*(.*)$/)
    return !!(m && parseInt(m[1]) === n)
  }
  for (let i = 0; i < lines.length; i++) {
    if (is(lines[i], 49) || is(lines[i], 50) || lines[i].text.includes('50.') || lines[i].text.includes('49.')) {
      // dump 20 lines around
      const s = Math.max(0, i - 1), e = Math.min(lines.length, i + 15)
      console.log('--- match at idx', i, '---')
      for (let j = s; j < e; j++) {
        console.log(`p${lines[j].pi} y${lines[j].ly} x${lines[j].x}: ${lines[j].text}`)
      }
      console.log()
    }
  }
  // Also dump last 30 lines total
  console.log('=== last 30 lines of PDF ===')
  for (let i = Math.max(0, lines.length - 30); i < lines.length; i++) {
    console.log(`p${lines[i].pi} y${lines[i].ly} x${lines[i].x}: ${lines[i].text}`)
  }
})().catch(e => { console.error(e); process.exit(1) })
