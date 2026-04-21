#!/usr/bin/env node
// One-shot: fix doctor1 111100 question 29 (vertebrae figure).
// C6 reported the question references 甲、乙、丙 vertebrae but no image renders.
// Source PDF: doctor1_111100_c301_s11.pdf, page 5, image at y≈153 x≈51 (325x135).
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const BACKEND = path.join(__dirname, '..')
const PDF_PATH = path.join(BACKEND, '_tmp', 'pdf-cache', 'doctor1_111100_c301_s11.pdf')
const IMG_OUT_DIR = path.join(BACKEND, '..', 'frontend', 'public', 'question-images')
const QFILE = path.join(BACKEND, 'questions.json')
const Q_ID = '111100_1_29'

;(async () => {
  const mupdf = await import('mupdf')
  const buf = fs.readFileSync(PDF_PATH)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')

  // Find page that has anchor 29 + an image bbox just below it
  let target = null
  for (let pi = 0; pi < doc.countPages(); pi++) {
    const pg = doc.loadPage(pi)
    const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
    let anchor29 = null
    const images = []
    for (const b of parsed.blocks || []) {
      if (b.type === 'text') {
        for (const ln of (b.lines || [])) {
          const m = (ln.text || '').trim().match(/^29[.．、]\s*(.*)/)
          if (m && m[1] && /椎骨|甲|乙|丙/.test(m[1])) anchor29 = ln.bbox
        }
      } else if (b.type === 'image') {
        if (b.bbox.w >= 50 && b.bbox.h >= 50) images.push(b.bbox)
      }
    }
    if (anchor29) {
      // pick the image whose top is below the anchor's top, closest to it
      const below = images.filter(im => im.y >= anchor29.y - 5).sort((a, b) => a.y - b.y)
      if (below.length) {
        target = { page: pg, bbox: below[0], pageIdx: pi }
        break
      }
    }
  }
  if (!target) {
    console.error('Could not locate q29 image')
    process.exit(1)
  }
  console.log(`Found image on page ${target.pageIdx + 1}: ${JSON.stringify(target.bbox)}`)

  // Render and crop
  const SCALE = 2, MARGIN = 2
  const m = mupdf.Matrix.scale(SCALE, SCALE)
  const pixmap = target.page.toPixmap(m, mupdf.ColorSpace.DeviceRGB, false)
  const png = Buffer.from(pixmap.asPNG())
  const pw = pixmap.getWidth(), ph = pixmap.getHeight()
  const left = Math.max(0, Math.floor((target.bbox.x - MARGIN) * SCALE))
  const top = Math.max(0, Math.floor((target.bbox.y - MARGIN) * SCALE))
  const right = Math.min(pw, Math.ceil((target.bbox.x + target.bbox.w + MARGIN) * SCALE))
  const bottom = Math.min(ph, Math.ceil((target.bbox.y + target.bbox.h + MARGIN) * SCALE))
  const width = right - left
  const height = bottom - top

  fs.mkdirSync(IMG_OUT_DIR, { recursive: true })
  const fname = `doctor1_${Q_ID}_0.webp`
  const outPath = path.join(IMG_OUT_DIR, fname)
  await sharp(png).extract({ left, top, width, height }).webp({ quality: 82 }).toFile(outPath)
  console.log(`Wrote ${fname} (${width}x${height})`)

  // Patch JSON
  const db = JSON.parse(fs.readFileSync(QFILE, 'utf8'))
  const q = db.questions.find(x => x.id === Q_ID)
  if (!q) { console.error('Question not found'); process.exit(1) }
  q.images = ['/question-images/' + fname]
  if (db.metadata) db.metadata.last_updated = new Date().toISOString()
  fs.writeFileSync(QFILE, JSON.stringify(db, null, 2))
  console.log(`Updated questions.json: ${Q_ID}.images = [${fname}]`)
})().catch(e => { console.error(e); process.exit(1) })
