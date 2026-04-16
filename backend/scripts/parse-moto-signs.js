#!/usr/bin/env node
/**
 * parse-moto-signs.js — 從機車駕照筆試題庫 PDF 提取標誌圖片
 *
 * 輸入：backend/_driver_license/moto_all_804.pdf (804 題，其中 148 題有標誌圖)
 * 輸出：
 *   - frontend/public/signs/moto_sign_NNN.png (148 張 PNG)
 *   - 更新 backend/questions-driver-moto.json (為有圖的題目加上 image_url)
 *
 * 機車題庫格式：三選一選擇題，圖片在 x~304 位置，與題目同行
 */

const fs = require('fs')
const path = require('path')

const PDF_PATH = path.resolve(__dirname, '..', '_driver_license', 'moto_all_804.pdf')
const SIGNS_DIR = path.resolve(__dirname, '..', '..', 'frontend', 'public', 'signs')
const MOTO_JSON = path.resolve(__dirname, '..', 'questions-driver-moto.json')

async function main() {
  const mupdf = await import('mupdf')

  const buf = fs.readFileSync(PDF_PATH)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const totalPages = doc.countPages()

  fs.mkdirSync(SIGNS_DIR, { recursive: true })

  const scale = 3 // 3x for crisp signs
  const imageMap = new Map() // qNum -> image filename

  for (let pi = 0; pi < totalPages; pi++) {
    const pg = doc.loadPage(pi)
    const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())

    const lines = []
    const images = []
    for (const b of parsed.blocks) {
      if (b.type === 'text') {
        for (const ln of (b.lines || [])) {
          const t = (ln.text || '').trim()
          if (t) lines.push({ x: Math.round(ln.bbox.x), y: Math.round(ln.bbox.y), text: t })
        }
      } else if (b.type === 'image') {
        images.push({
          x: Math.round(b.bbox.x),
          y: Math.round(b.bbox.y),
          w: Math.round(b.bbox.w),
          h: Math.round(b.bbox.h),
        })
      }
    }

    if (images.length === 0) continue

    // Find question numbers (at x < 50, just digits)
    const qNums = lines
      .filter(ln => ln.x < 50 && /^\d{1,3}$/.test(ln.text))
      .map(ln => ({ num: parseInt(ln.text), y: ln.y }))
      .sort((a, b) => a.y - b.y)

    // For each image, find closest question by y distance
    for (const img of images) {
      let bestQ = null
      let bestDist = Infinity
      for (const q of qNums) {
        const dist = Math.abs(img.y - q.y)
        if (dist < bestDist) {
          bestDist = dist
          bestQ = q
        }
      }
      if (!bestQ || bestDist > 80) {
        console.log(`  Page ${pi}: image at y=${img.y} no matching question (bestDist=${bestDist})`)
        continue
      }

      const num = bestQ.num
      const pad = 2
      const ix = img.x - pad
      const iy = img.y - pad
      const iw = img.w + pad * 2
      const ih = img.h + pad * 2

      const tm = mupdf.Matrix.concat(
        mupdf.Matrix.translate(-ix, -iy),
        mupdf.Matrix.scale(scale, scale)
      )
      const pw = Math.round(iw * scale)
      const ph = Math.round(ih * scale)
      const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, pw, ph], false)
      pix.clear(255)
      const device = new mupdf.DrawDevice(tm, pix)
      pg.run(device, mupdf.Matrix.identity)
      device.close()

      const fname = `moto_sign_${String(num).padStart(3, '0')}.png`
      fs.writeFileSync(path.join(SIGNS_DIR, fname), pix.asPNG())
      imageMap.set(num, fname)
    }

    process.stdout.write(`  Page ${pi}/${totalPages - 1}: ${images.length} images\r`)
  }

  console.log(`\nExtracted ${imageMap.size} sign images`)

  // Update existing questions with image_url
  const questions = JSON.parse(fs.readFileSync(MOTO_JSON, 'utf8'))
  let updated = 0
  for (const q of questions) {
    const fname = imageMap.get(q.number)
    if (fname) {
      q.image_url = `/signs/${fname}`
      updated++
    }
  }

  const tmp = MOTO_JSON + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(questions, null, 2), 'utf-8')
  fs.renameSync(tmp, MOTO_JSON)

  console.log(`Updated ${updated} questions with image_url (of ${imageMap.size} images found)`)
}

main().catch(e => { console.error(e); process.exit(1) })
