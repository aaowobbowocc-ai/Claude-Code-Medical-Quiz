#!/usr/bin/env node
// Re-extract images for medlab 104020 臨床血液學 — the PDF stores figures as
// hundreds of 1-2px scanline strips, so the original extractor split/mis-
// assigned them. This: merges slivers per page → renders page 2x → crops each
// merged image → maps to the question whose "N." line sits just above it.
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const PDF = path.join(__dirname, '..', '_tmp', 'pdf-cache', 'medlab_104020_c311_s22.pdf')
const IMG_OUT = path.join(__dirname, '..', '..', 'frontend', 'public', 'question-images')
const SCALE = 3

async function main() {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(fs.readFileSync(PDF)), 'application/pdf')
  const assign = {}
  let lastQ = null // carry across pages for images at page-top

  for (let p = 0; p < doc.countPages(); p++) {
    const page = doc.loadPage(p)
    const st = JSON.parse(page.toStructuredText('preserve-images').asJSON())
    const blocks = st.blocks || []
    // Merge image slivers — group by (x bucket, w bucket), union y
    const groups = {}
    for (const b of blocks) {
      if (b.type !== 'image') continue
      const key = Math.round(b.bbox.x / 15) + '_' + Math.round(b.bbox.w / 15)
      const g = groups[key]
      if (!g) groups[key] = { x0: b.bbox.x, y0: b.bbox.y, x1: b.bbox.x + b.bbox.w, y1: b.bbox.y + b.bbox.h }
      else {
        g.x0 = Math.min(g.x0, b.bbox.x); g.y0 = Math.min(g.y0, b.bbox.y)
        g.x1 = Math.max(g.x1, b.bbox.x + b.bbox.w); g.y1 = Math.max(g.y1, b.bbox.y + b.bbox.h)
      }
    }
    const imgs = Object.values(groups).filter(g => (g.x1 - g.x0) > 40 && (g.y1 - g.y0) > 20)
      .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
    if (!imgs.length) continue
    // Question "N." text lines with y
    const qlines = []
    for (const b of blocks) {
      if (b.type !== 'text') continue
      for (const l of (b.lines || [])) {
        const m = (l.text || '').trim().match(/^(\d{1,2})[.．、]/)
        if (m) qlines.push({ n: parseInt(m[1]), y: l.bbox.y })
      }
    }
    qlines.sort((a, b) => a.y - b.y)
    // Render page at SCALE
    const pix = page.toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceRGB, false)
    const png = pix.asPNG()
    // Crop each image
    for (let i = 0; i < imgs.length; i++) {
      const g = imgs[i]
      // owning question = last qline with y < image top
      let owner = null
      for (const q of qlines) { if (q.y < g.y0 + 5) owner = q.n; else break }
      if (owner == null) owner = lastQ // image at page-top → previous page last Q
      if (owner == null) continue
      const M = 3
      const left = Math.max(0, Math.round((g.x0 - M) * SCALE))
      const top = Math.max(0, Math.round((g.y0 - M) * SCALE))
      const w = Math.round((g.x1 - g.x0 + 2 * M) * SCALE)
      const h = Math.round((g.y1 - g.y0 + 2 * M) * SCALE)
      const idx = (assign[owner] || []).length
      const name = `medlab_104020_q${owner}_${idx}.webp`
      await sharp(png).extract({ left, top, width: w, height: h }).webp({ quality: 88 }).toFile(path.join(IMG_OUT, name))
      assign[owner] = (assign[owner] || []).concat(name)
      console.log(`page ${p} img → Q${owner}: ${name} (${w}x${h})`)
    }
  }
  fs.writeFileSync(path.join(__dirname, '_medlab104020-imgmap.json'), JSON.stringify(assign, null, 2))
  console.log('\nassign map:', JSON.stringify(assign))
}
main().catch(e => { console.error(e); process.exit(1) })
