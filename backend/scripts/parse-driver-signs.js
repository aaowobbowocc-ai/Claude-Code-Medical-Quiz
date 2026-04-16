#!/usr/bin/env node
/**
 * parse-driver-signs.js — 從公路局駕照標誌是非題 PDF 提取圖片 + 題目
 *
 * 輸入：backend/_driver_license/car_signs_tf.pdf (240 題, 每題一張標誌圖)
 * 輸出：
 *   - frontend/public/signs/sign_NNN.png  (240 張 PNG)
 *   - 合併進 backend/questions-driver-car.json (新增 240 題 car_signs 標籤)
 *
 * 題目格式：是非題 ○/X
 *   - 「圖中標誌是___」→ 答案 ○(A) 表示標誌名稱正確, X(B) 表示錯誤
 */

const fs = require('fs')
const path = require('path')

const PDF_PATH = path.resolve(__dirname, '..', '_driver_license', 'car_signs_tf.pdf')
const SIGNS_DIR = path.resolve(__dirname, '..', '..', 'frontend', 'public', 'signs')
const CAR_JSON = path.resolve(__dirname, '..', 'questions-driver-car.json')

async function main() {
  const mupdf = await import('mupdf')

  const buf = fs.readFileSync(PDF_PATH)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const totalPages = doc.countPages()

  fs.mkdirSync(SIGNS_DIR, { recursive: true })

  const questions = []
  const scale = 3 // 3x for crisp signs

  for (let pi = 1; pi < totalPages; pi++) {
    const pg = doc.loadPage(pi)
    const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())

    // Collect text lines and image bboxes
    const textLines = []
    const images = []

    for (const b of parsed.blocks) {
      if (b.type === 'text') {
        for (const ln of (b.lines || [])) {
          const t = (ln.text || '').trim()
          if (!t) continue
          textLines.push({ x: Math.round(ln.bbox.x), y: Math.round(ln.bbox.y), text: t })
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

    // Find question rows: 題號 at x < 80, 3-digit number
    const qNums = textLines
      .filter(ln => ln.x < 80 && /^\d{3}$/.test(ln.text))
      .map(ln => ({ num: parseInt(ln.text), y: ln.y }))
      .sort((a, b) => a.y - b.y)

    // Sort images by y to match 1:1 with questions (same count per page)
    const sortedImages = [...images].sort((a, b) => a.y - b.y)

    for (let qi = 0; qi < qNums.length; qi++) {
      const { num, y: qY } = qNums[qi]

      // Find answer (○ or X) near this y, x ~100
      const ansLine = textLines.find(
        ln => Math.abs(ln.y - qY) < 10 && ln.x > 80 && ln.x < 130
      )
      const ansRaw = ansLine ? ansLine.text : ''
      const answer = ansRaw === '○' ? 'A' : 'B' // ○=correct(A), X=wrong(B)

      // Find question text at x ~239
      const textParts = textLines
        .filter(ln => Math.abs(ln.y - qY) < 10 && ln.x > 200 && ln.x < 480)
        .sort((a, b) => a.x - b.x)
      const questionText = textParts.map(p => p.text).join('').trim()

      // Find category at x ~490
      const catLine = textLines.find(
        ln => Math.abs(ln.y - qY) < 10 && ln.x > 480
      )
      const category = catLine ? catLine.text.trim() : ''

      // Match image by sorted index (1:1 with questions)
      const matchImg = qi < sortedImages.length ? sortedImages[qi] : null

      if (!matchImg) {
        console.log(`  Q${String(num).padStart(3, '0')}: no image found (qi=${qi})`)
        continue
      }

      // Extract image: render the region from the page
      const pad = 2
      const ix = matchImg.x - pad
      const iy = matchImg.y - pad
      const iw = matchImg.w + pad * 2
      const ih = matchImg.h + pad * 2

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

      const fname = `sign_${String(num).padStart(3, '0')}.png`
      fs.writeFileSync(path.join(SIGNS_DIR, fname), pix.asPNG())

      questions.push({
        id: `car_sign_${num}`,
        subject: '汽車標誌標線號誌',
        subject_tag: 'car_signs',
        subject_name: '汽車標誌、標線、號誌是非題',
        stage_id: 0,
        number: num,
        question: questionText || `(標誌圖 ${String(num).padStart(3, '0')})`,
        options: { A: '○（正確）', B: '✕（錯誤）' },
        answer,
        type: 'tf',
        image_url: `/signs/${fname}`,
        sign_category: category,
      })
    }

    process.stdout.write(`  Page ${pi}/${totalPages - 1}: ${qNums.length} questions\r`)
  }

  console.log(`\nExtracted ${questions.length} sign questions with images`)

  // Merge into existing car question bank
  const existing = JSON.parse(fs.readFileSync(CAR_JSON, 'utf8'))
  // Remove any previous car_sign entries
  const filtered = existing.filter(q => !q.id?.startsWith('car_sign_'))
  const merged = filtered.concat(questions)

  const tmp = CAR_JSON + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8')
  fs.renameSync(tmp, CAR_JSON)

  console.log(`Car questions: ${filtered.length} existing + ${questions.length} signs = ${merged.length} total`)
}

main().catch(e => { console.error(e); process.exit(1) })
