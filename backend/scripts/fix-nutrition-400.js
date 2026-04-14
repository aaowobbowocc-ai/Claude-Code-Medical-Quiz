#!/usr/bin/env node
// Crop the succinate structure image for nutrition 400 (115030 #50, paper 3
// 生理學與生物化學). The PDF for c=102 was downloaded into the cache after
// the bulk image pass ran. The bulk script picks c=101 first (which is
// actually 護理師 in the 030 series) and matches the wrong PDF, so we can't
// just re-run it without surgery. One-off path here.
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const PDF = path.join(__dirname, '..', '_tmp', 'pdf-cache', 'nutrition_115030_c102_s0203.pdf')
const IMG_OUT = path.join(__dirname, '..', '..', 'frontend', 'public', 'question-images')
const RENDER_SCALE = 2
const MARGIN = 2
const MIN_IMG_DIM = 30

;(async () => {
  const mupdf = await import('mupdf')
  const buf = fs.readFileSync(PDF)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')

  // First pass: locate the page where 50. starts and the page+y where 51. starts
  let startPage = -1, startY = 0, endPage = -1, endY = 1e6
  for (let i = 0; i < doc.countPages(); i++) {
    const pg = doc.loadPage(i)
    const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
    for (const b of parsed.blocks || []) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const t = (ln.text || '').trim()
        if (/^50[.．、]/.test(t) && startPage < 0) { startPage = i; startY = ln.bbox.y }
        else if (/^51[.．、]/.test(t) && startPage >= 0 && endPage < 0) { endPage = i; endY = ln.bbox.y }
      }
    }
    if (endPage >= 0) break
  }
  console.log(`Q50 spans page ${startPage + 1} (y=${startY}) → page ${endPage + 1} (y=${endY})`)
  if (startPage < 0) { console.error('Q50 not found'); process.exit(1) }

  let saved = []
  for (let i = startPage; i <= (endPage < 0 ? doc.countPages() - 1 : endPage); i++) {
    const pg = doc.loadPage(i)
    const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
    const yMin = (i === startPage) ? startY - 2 : 0
    const yMax = (i === endPage) ? endY : 1e6
    const imgs = []
    for (const b of parsed.blocks || []) {
      if (b.type !== 'image') continue
      const bb = b.bbox
      if (bb.w < MIN_IMG_DIM || bb.h < MIN_IMG_DIM) continue
      if (bb.y < yMin || bb.y > yMax) continue
      imgs.push(bb)
    }
    imgs.sort((a, b) => a.y - b.y || a.x - b.x)
    console.log(`page ${i+1}: ${imgs.length} images in y-range`)
    const m = mupdf.Matrix.scale(RENDER_SCALE, RENDER_SCALE)
    const pixmap = pg.toPixmap(m, mupdf.ColorSpace.DeviceRGB, false)
    const png = Buffer.from(pixmap.asPNG())
    const pw = pixmap.getWidth(), ph = pixmap.getHeight()
    for (const bb of imgs) {
      const left = Math.max(0, Math.floor((bb.x - MARGIN) * RENDER_SCALE))
      const top = Math.max(0, Math.floor((bb.y - MARGIN) * RENDER_SCALE))
      const right = Math.min(pw, Math.ceil((bb.x + bb.w + MARGIN) * RENDER_SCALE))
      const bottom = Math.min(ph, Math.ceil((bb.y + bb.h + MARGIN) * RENDER_SCALE))
      const width = right - left, height = bottom - top
      if (width < 10 || height < 10) continue
      const fname = `nutrition_400_${saved.length}.webp`
      const outPath = path.join(IMG_OUT, fname)
      await sharp(png).extract({ left, top, width, height }).webp({ quality: 82 }).toFile(outPath)
      saved.push('/question-images/' + fname)
      console.log(`  saved ${fname} (${width}x${height})`)
    }
  }

  if (!saved.length) { console.error('no images saved'); process.exit(1) }

  // Update DB
  const fp = path.join(__dirname, '..', 'questions-nutrition.json')
  const db = JSON.parse(fs.readFileSync(fp, 'utf8'))
  const q = db.questions.find(x => x.id === 400)
  q.images = saved
  if (db.metadata) db.metadata.last_updated = new Date().toISOString()
  fs.writeFileSync(fp, JSON.stringify(db, null, 2))
  console.log(`✓ nutrition 400: attached ${saved.length} image(s)`)
})().catch(e => { console.error(e); process.exit(1) })
