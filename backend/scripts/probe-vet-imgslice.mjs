// Prototype: slice vet 102-2 獸醫實驗診斷學 PDF by question y-boundary.
// Output: scripts/out/vet-102-slice/q-<num>.png — user reviews quality.

import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'out', 'vet-102-slice')
fs.mkdirSync(OUT, { recursive: true })

// vet 102-2 獸醫實驗診斷學 — 73/80, missing 7 likely image-dep
const URL = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=Q&code=102100&c=307&s=33&q=1'

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
  })
}

const buf = await download(URL)
console.log('Downloaded', buf.length, 'bytes')

const doc = mupdf.PDFDocument.openDocument(buf, 'application/pdf')
const pageCount = doc.countPages()
console.log('Pages:', pageCount)

const DPI = 150
const SCALE = DPI / 72

for (let pi = 0; pi < pageCount; pi++) {
  const page = doc.loadPage(pi)
  const bbox = page.getBounds() // [x0, y0, x1, y1] in PDF points (72 dpi)
  const pageH = bbox[3] - bbox[1]

  // Render page to PNG at DPI
  const pixmap = page.toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceRGB, false, false)
  const png = pixmap.asPNG()

  // Collect text structure. mupdf's StructuredText gives blocks with bbox.
  // Find lines starting with "N." (question number markers).
  const stext = page.toStructuredText('preserve-whitespace')
  const json = JSON.parse(stext.asJSON())
  const yStarts = [] // {num, yPoints, yPx}
  for (const block of (json.blocks || [])) {
    if (block.type !== 'text') continue
    for (const line of (block.lines || [])) {
      const txt = (line.text || '').trim()
      const m = txt.match(/^(\d{1,3})\.\s*$/) || txt.match(/^(\d{1,3})\./)
      if (m) {
        const num = parseInt(m[1])
        if (num >= 1 && num <= 80) {
          const y = line.bbox.y
          yStarts.push({ num, yPoints: y, yPx: Math.round(y * SCALE) })
        }
      }
    }
  }
  console.log(`Page ${pi + 1}: found ${yStarts.length} question markers`, yStarts.map(y => y.num).slice(0, 10), '...')

  if (yStarts.length === 0) continue

  const pageImg = sharp(Buffer.from(png))
  const meta = await pageImg.metadata()
  const W = meta.width, H = meta.height

  for (let qi = 0; qi < yStarts.length; qi++) {
    const cur = yStarts[qi]
    const next = yStarts[qi + 1]
    const top = Math.max(0, cur.yPx - 5)
    const bottom = next ? next.yPx - 5 : H
    const height = bottom - top
    if (height < 30) continue
    const outPath = path.join(OUT, `p${pi + 1}-q${cur.num}.png`)
    await sharp(Buffer.from(png))
      .extract({ left: 0, top, width: W, height: Math.min(height, H - top) })
      .toFile(outPath)
  }
}

console.log('Done. Output:', OUT)
