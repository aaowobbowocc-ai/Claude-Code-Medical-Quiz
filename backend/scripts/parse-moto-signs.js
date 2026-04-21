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

  // Preload question text so image→question assignment can prefer empty-text
  // or image-keyword questions when multiple candidates are within range.
  const IMG_KEYWORDS = /圖|標誌|標線|號誌|手勢|箭頭|燈|斑馬|車道|圓環|本標|左臂|右臂|指示|警告|禁制|道路指定|指定/
  const allQs = JSON.parse(fs.readFileSync(MOTO_JSON, 'utf8'))
  const questionByNum = new Map()
  for (const q of allQs) questionByNum.set(q.number, q)
  function qIsImageSlot(num) {
    const t = (questionByNum.get(num)?.question || '').trim()
    return !t || IMG_KEYWORDS.test(t)
  }

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

    // For each image, find candidate questions within 80px window, then
    // prefer the one whose JSON text is empty or contains an image keyword
    // — previously the raw |dy| winner was often the text-only question
    // *above* the image, leaving its image-only neighbour orphaned.
    for (const img of images) {
      const candidates = qNums
        .map(q => ({ q, dist: Math.abs(img.y - q.y) }))
        .filter(c => c.dist <= 80)
        .sort((a, b) => a.dist - b.dist)
      if (!candidates.length) {
        console.log(`  Page ${pi}: image at y=${img.y} no match within 80px`)
        continue
      }
      const preferred = candidates.find(c => qIsImageSlot(c.q.num)) || candidates[0]
      const bestQ = preferred.q

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
  const questions = allQs
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
