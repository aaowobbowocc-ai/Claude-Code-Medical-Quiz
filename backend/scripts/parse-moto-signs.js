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

    // For each image, find closest question by |dy|. The image bbox y is
    // top-left while question-number text y is a baseline, so legit pairs
    // can be 60+px apart for tall sign images — keep the 80px window and
    // rely on the keyword filter below as the real safety gate.
    for (const img of images) {
      let bestQ = null
      let bestDist = Infinity
      for (const q of qNums) {
        const dist = Math.abs(img.y - q.y)
        if (dist < bestDist) { bestDist = dist; bestQ = q }
      }
      if (!bestQ || bestDist > 80) {
        console.log(`  Page ${pi}: image at y=${img.y} no match (bestDist=${bestDist})`)
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

  // Update existing questions with image_url. Second safety gate: if the
  // question text is non-empty and doesn't reference an image (no 圖/標誌/
  // 標線/號誌/手勢/箭頭/燈/斑馬/車道/圓環/本標/左臂/右臂/指示/警告/禁制),
  // skip — the PDF proximity match was spurious.
  const IMG_KEYWORDS = /圖|標誌|標線|號誌|手勢|箭頭|燈|斑馬|車道|圓環|本標|左臂|右臂|指示|警告|禁制/
  const questions = JSON.parse(fs.readFileSync(MOTO_JSON, 'utf8'))
  let updated = 0
  let skipped = 0
  for (const q of questions) {
    // Clear any stale assignment so re-runs are idempotent and fix prior drift.
    if (q.image_url) delete q.image_url
    const fname = imageMap.get(q.number)
    if (!fname) continue
    const text = (q.question || '').trim()
    if (text && !IMG_KEYWORDS.test(text)) {
      console.log(`  Skip q.${q.number} — text has no image keyword: ${text.slice(0, 40)}`)
      skipped++
      continue
    }
    q.image_url = `/signs/${fname}`
    updated++
  }
  console.log(`Skipped ${skipped} keyword-mismatch assignments`)

  const tmp = MOTO_JSON + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(questions, null, 2), 'utf-8')
  fs.renameSync(tmp, MOTO_JSON)

  console.log(`Updated ${updated} questions with image_url (of ${imageMap.size} images found)`)
}

main().catch(e => { console.error(e); process.exit(1) })
