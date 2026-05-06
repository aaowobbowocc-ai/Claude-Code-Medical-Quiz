#!/usr/bin/env node
/**
 * Re-extract Q3/Q4/Q5 images for dental1 105-1 卷二.
 *
 * Strategy: render each question's full vertical strip (text + figures + labels)
 * as a single webp. This preserves the 圖一/圖A markers in context so the user
 * can match figures to labels visually.
 */

const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')
const OUT_DIR  = path.join(BACKEND, '..', 'frontend', 'public', 'question-images')

const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')

async function findQuestionRanges(pdfPath, questionNumbers) {
  const mupdf = await import('mupdf')
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const ranges = []  // { qn, page, y1, y2, pageNext?, y2Next? }
  for (let p = 0; p < doc.countPages(); p++) {
    const page = doc.loadPage(p)
    const json = JSON.parse(page.toStructuredText('preserve-images').asJSON())
    const blocks = (json.blocks || []).filter(b => b.type === 'text' || b.type === 'image')
    for (const b of blocks) {
      if (b.type !== 'text') continue
      const firstLine = (b.lines || [])[0]?.text || ''
      const m = firstLine.match(/^(\d{1,3})\./)
      if (!m) continue
      const qn = parseInt(m[1])
      if (!questionNumbers.includes(qn)) continue
      ranges.push({ qn, page: p, y1: b.bbox.y, x: b.bbox.x })
    }
  }
  // Sort by (page, y1)
  ranges.sort((a, b) => a.page - b.page || a.y1 - b.y1)
  // Determine y2 = start of next question (same page) or page bottom
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i]
    const nextSame = ranges[i+1] && ranges[i+1].page === r.page ? ranges[i+1] : null
    if (nextSame) {
      r.y2 = nextSame.y1 - 6
    } else {
      // continues to end of page; need image search next page for option text or next q
      r.y2 = null  // means: to bottom of page
      r.continuesNext = true
    }
  }
  return { doc, ranges }
}

async function extractStrip(doc, page, x1, y1, x2, y2, scale = 2) {
  const mupdf = await import('mupdf')
  const pg = doc.loadPage(page)
  const pixmap = pg.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true)
  const png = Buffer.from(pixmap.asPNG())
  // Crop using sharp
  const meta = await sharp(png).metadata()
  const W = meta.width, H = meta.height
  const cx1 = Math.max(0, Math.floor(x1 * scale))
  const cy1 = Math.max(0, Math.floor(y1 * scale))
  const cx2 = Math.min(W, Math.ceil(x2 * scale))
  const cy2 = Math.min(H, Math.ceil(y2 * scale))
  return sharp(png)
    .extract({ left: cx1, top: cy1, width: cx2 - cx1, height: cy2 - cy1 })
    .webp({ quality: 80 })
    .toBuffer()
}

async function main() {
  const pdfPath = path.join(PDF_CACHE, 'dental1_105020_c303_s22.pdf')
  const QUESTIONS = [3, 4, 5]
  const { doc, ranges } = await findQuestionRanges(pdfPath, QUESTIONS)

  const mupdf = await import('mupdf')
  // Page width/height
  const pgRect = doc.loadPage(0).getBounds()
  const pageH = pgRect[3]
  const pageW = pgRect[2]
  console.log('page bounds:', pgRect, 'W='+pageW, 'H='+pageH)

  for (const r of ranges) console.log('Q'+r.qn+' page='+r.page+' y1='+r.y1+' y2='+r.y2+' continuesNext='+r.continuesNext)

  // For each question, render strip(s) and combine vertically
  const outputs = {}
  for (const r of ranges) {
    const strips = []
    // Strip on its own page
    const y2 = r.y2 != null ? r.y2 : pageH
    strips.push(await extractStrip(doc, r.page, 30, r.y1 - 4, pageW - 30, y2))
    // If continues to next page, find first marker on next page (next question or "代號" header)
    if (r.continuesNext && r.page + 1 < doc.countPages()) {
      const nextPage = doc.loadPage(r.page + 1)
      const j2 = JSON.parse(nextPage.toStructuredText('preserve-images').asJSON())
      let cutY = pageH
      for (const b of (j2.blocks || [])) {
        if (b.type !== 'text') continue
        const ft = (b.lines || [])[0]?.text || ''
        if (/^\d+\./.test(ft) || /代\s*號/.test(ft) || /頁\s*次/.test(ft)) {
          cutY = b.bbox.y - 4
          break
        }
      }
      strips.push(await extractStrip(doc, r.page + 1, 30, 24, pageW - 30, cutY))
    }
    // Stack strips vertically
    let combined
    if (strips.length === 1) {
      combined = strips[0]
    } else {
      const metas = await Promise.all(strips.map(s => sharp(s).metadata()))
      const totalH = metas.reduce((s, m) => s + m.height, 0)
      const maxW = Math.max(...metas.map(m => m.width))
      const composites = []
      let acc = 0
      for (let i = 0; i < strips.length; i++) {
        composites.push({ input: strips[i], top: acc, left: 0 })
        acc += metas[i].height
      }
      combined = await sharp({ create: { width: maxW, height: totalH, channels: 3, background: '#ffffff' } })
        .composite(composites)
        .webp({ quality: 80 })
        .toBuffer()
    }
    const fname = `dental1_105020_p2_${r.qn}_0.webp`
    fs.writeFileSync(path.join(OUT_DIR, fname), combined)
    console.log(`✓ Q${r.qn}: ${fname} (${combined.length} bytes)`)
    outputs[r.qn] = `/question-images/${fname}`
  }

  // Update JSON
  const jsonFile = path.join(BACKEND, 'questions-dental1.json')
  const data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
  const arr = data.questions || data
  for (const q of arr) {
    if (q.exam_code !== '105020' || q.subject !== '卷二') continue
    if (outputs[q.number]) {
      q.images = [outputs[q.number]]
    }
  }
  fs.writeFileSync(jsonFile, JSON.stringify(data, null, 2))
  console.log('✓ JSON updated')
}

main().catch(e => { console.error(e); process.exit(1) })
