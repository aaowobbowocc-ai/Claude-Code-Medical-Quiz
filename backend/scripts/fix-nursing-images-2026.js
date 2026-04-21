#!/usr/bin/env node
// One-off image extraction for two nursing questions that the bulk
// add-missing-images.js can't reach because pickClassCode picks up stale
// cached c=101 PDFs (which are actually 中醫師, not 護理師) and never
// probes the correct classCode.
//
//   1. 111030_0304_14 (產兒科 #14 — 胎兒先露部位下圖編號)
//      PDF: nursing_Q_111030_c104_s0304.pdf
//   2. 112110_0205_63 (精神社區 #63 — 家庭圈如圖示)
//      PDF: nursing_Q_112110_c102_s0205.pdf
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')
const IMG_OUT = path.join(BACKEND, '..', 'frontend', 'public', 'question-images')
const RENDER_SCALE = 2
const MARGIN = 2
const MIN_IMG_DIM = 30

const TARGETS = [
  { id: '111030_0304_14', pdf: 'nursing_Q_111030_c104_s0304.pdf', number: 14 },
  { id: '112110_0205_63', pdf: 'nursing_Q_112110_c102_s0205.pdf', number: 63 },
]

async function extractForTarget(t) {
  const mupdf = await import('mupdf')
  const buf = fs.readFileSync(path.join(PDF_CACHE, t.pdf))
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')

  // Find page+y where this question starts and where the next one starts
  let startPage = -1, startY = 0, endPage = -1, endY = 1e6
  // PDF lines often have the number alone (e.g. "14") in a narrow left column,
  // separate from the question text — match both bare digits and numbered.
  const startRe = new RegExp(`^${t.number}([.．、]|$)`)
  const nextRe = new RegExp(`^${t.number + 1}([.．、]|$)`)
  for (let i = 0; i < doc.countPages(); i++) {
    const pg = doc.loadPage(i)
    const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
    for (const b of parsed.blocks || []) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const txt = (ln.text || '').trim()
        if (startPage < 0 && startRe.test(txt)) { startPage = i; startY = ln.bbox.y }
        else if (endPage < 0 && startPage >= 0 && nextRe.test(txt)) { endPage = i; endY = ln.bbox.y }
      }
    }
    if (endPage >= 0) break
  }
  if (startPage < 0) { console.error(`  ${t.id}: question #${t.number} not found in PDF`); return [] }
  if (endPage < 0) endPage = doc.countPages() - 1
  console.log(`  ${t.id}: spans page ${startPage + 1} (y=${startY}) → page ${endPage + 1} (y=${endY})`)

  const saved = []
  for (let i = startPage; i <= endPage; i++) {
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
    if (!imgs.length) continue

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
      const fname = `nursing_${t.id}_${saved.length}.webp`
      const outPath = path.join(IMG_OUT, fname)
      await sharp(png).extract({ left, top, width, height }).webp({ quality: 82 }).toFile(outPath)
      saved.push('/question-images/' + fname)
      console.log(`    saved ${fname} (${width}x${height})`)
    }
  }
  return saved
}

;(async () => {
  const fp = path.join(BACKEND, 'questions-nursing.json')
  const db = JSON.parse(fs.readFileSync(fp, 'utf8'))
  let touched = 0
  for (const t of TARGETS) {
    const q = db.questions.find(x => x.id === t.id)
    if (!q) { console.error(`  ${t.id}: not in DB`); continue }
    const saved = await extractForTarget(t)
    if (saved.length) { q.images = saved; touched++ }
  }
  if (touched) {
    if (db.metadata) db.metadata.last_updated = new Date().toISOString()
    fs.writeFileSync(fp, JSON.stringify(db, null, 2))
    console.log(`✓ updated ${touched} question(s)`)
  }
})().catch(e => { console.error(e); process.exit(1) })
