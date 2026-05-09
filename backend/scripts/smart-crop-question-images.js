#!/usr/bin/env node
/**
 * 重新精準裁切已有 image_url 的題目，只裁該題範圍（題號 N → 題號 N+1 之前）。
 * 跨頁的題目自動加 _next.webp。
 *
 * Usage:
 *   node scripts/smart-crop-question-images.js --exam audiologist [--limit 20]
 *   node scripts/smart-crop-question-images.js --all
 */
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const BACKEND = path.resolve(__dirname, '..')
const PDF_CACHE_DIRS = [
  path.join(BACKEND, '_tmp', 'pdf-cache'),
  path.join(BACKEND, '_tmp', 'pdf-cache-100-105'),
]
const IMG_OUT = path.join(BACKEND, '..', 'frontend', 'public', 'question-images')
const SCALE = 3  // 216 DPI for sharp source

const EXAM_FILES = {
  doctor1: 'questions.json', doctor2: 'questions-doctor2.json',
  dental1: 'questions-dental1.json', dental2: 'questions-dental2.json',
  pharma1: 'questions-pharma1.json', pharma2: 'questions-pharma2.json',
  nursing: 'questions-nursing.json', nutrition: 'questions-nutrition.json',
  medlab: 'questions-medlab.json', pt: 'questions-pt.json', ot: 'questions-ot.json',
  radiology: 'questions-radiology.json', tcm1: 'questions-tcm1.json',
  tcm2: 'questions-tcm2.json', vet: 'questions-vet.json',
  audiologist: 'questions-audiologist.json',
  'speech-therapist': 'questions-speech-therapist.json',
  rt: 'questions-rt.json',
}

const args = process.argv.slice(2)
const examFilter = args[args.indexOf('--exam') + 1]
const limit = args.indexOf('--limit') >= 0 ? parseInt(args[args.indexOf('--limit') + 1]) : 0
const isAll = args.includes('--all')

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }

function findCandidatePdfs(exam, exam_code) {
  const out = []
  for (const dir of PDF_CACHE_DIRS) {
    if (!fs.existsSync(dir)) continue
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.pdf'))
    for (const f of files) {
      if (/^(TM|TS|M|S|A|TA)_/.test(f)) continue
      if (f.startsWith(`${exam}_${exam_code}_`) ||
          new RegExp(`(?:^|_)Q_${exam_code}_c\\d+_s`).test(f) ||
          new RegExp(`^[A-Za-z\\-]+_Q_${exam_code}_c\\d+_s`).test(f)) {
        out.push({ dir, file: f })
      }
    }
  }
  return out
}

const cleanText = s => (s || '').normalize('NFKC').replace(/[\s,，。、．.;；:：?？!！()（）「」『』《》<>【】\[\]]/g, '')

const pdfCache = {}
async function loadPdf(pdfPath) {
  if (pdfCache[pdfPath]) return pdfCache[pdfPath]
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const pages = []
  const n = doc.countPages()
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i)
    const text = page.toStructuredText('preserve-whitespace').asText().normalize('NFKC')
    const bounds = page.getBounds()  // [x0,y0,x1,y1] in PDF points
    pages.push({ page, text, idx: i, bounds })
  }
  const result = { doc, pages, mupdf }
  pdfCache[pdfPath] = result
  return result
}

/** Locate y-position (in PDF points, origin top-left) of question number N on a page.
 *  Uses mupdf's structured text JSON, looking for line starting with "N " or "N." or "N、"
 */
function findQuestionY(page, mupdf, qnum) {
  const stJson = JSON.parse(page.toStructuredText('preserve-whitespace').asJSON())
  // structure: blocks → lines → text + bbox
  for (const block of (stJson.blocks || [])) {
    if (!block.lines) continue
    for (const line of block.lines) {
      const t = (line.text || '').replace(/^\s+/, '')
      // Match line starting with the question number
      // Common patterns: "1 ", "1. ", "1、", "1．"
      const re = new RegExp(`^${qnum}(?:[.、．]|\\s)`)
      if (re.test(t)) {
        // line.bbox = { x: number, y: number, w: number, h: number }
        return line.bbox?.y ?? null
      }
    }
  }
  return null
}

async function smartCrop(pageInfo, mupdf, qnum, sourcePdf) {
  const ystart = findQuestionY(pageInfo.page, mupdf, qnum)
  if (ystart === null) return null
  const yend = findQuestionY(pageInfo.page, mupdf, qnum + 1)
  const bounds = pageInfo.bounds  // PDF points

  // PDF point → pixel scale
  const dpi = SCALE * 72  // 216 DPI default with SCALE=3

  // Clamp y range with small padding
  const padTop = 5
  const padBot = 5
  const cropY0 = Math.max(bounds[1], ystart - padTop)
  const cropY1 = yend !== null ? Math.min(bounds[3], yend - padBot) : bounds[3]

  // Build pixmap of the cropped region only
  const matrix = mupdf.Matrix.scale(SCALE, SCALE)
  // Render full page first, then crop pixel-wise (mupdf clip would be ideal but
  // simpler to render + sharp.extract)
  const fullPx = pageInfo.page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true)
  const fullBuf = Buffer.from(fullPx.asPNG())

  const meta = await sharp(fullBuf).metadata()
  const pdfH = bounds[3] - bounds[1]
  const pxPerPdfUnit = meta.height / pdfH
  const top = Math.round((cropY0 - bounds[1]) * pxPerPdfUnit)
  const cropH = Math.round((cropY1 - cropY0) * pxPerPdfUnit)
  if (cropH < 50) return null  // too thin, give up

  return {
    cropped: await sharp(fullBuf).extract({
      left: 0, top: Math.max(0, top), width: meta.width,
      height: Math.min(meta.height - top, cropH),
    }).webp({ quality: 82 }).toBuffer(),
    nextNeeded: yend === null,  // 沒找到下一題 → 可能跨頁
    sourceFile: sourcePdf,
  }
}

async function processExam(exam) {
  const file = EXAM_FILES[exam]
  if (!file) return { reCropped: 0 }
  const fp = path.join(BACKEND, file)
  if (!fs.existsSync(fp)) return { reCropped: 0 }
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data

  // Find candidates: any question with image_url that points to a patrol- or
  // full-page render (we want to re-crop these tighter)
  const targets = arr.filter(q =>
    q.image_url &&
    /\/question-images\/[^/]+_q\d+(?:_full|_patrol|_next)?\.webp$/.test(q.image_url)
  )
  if (limit > 0) targets.splice(limit)
  console.log(`\n[${exam}] ${targets.length} 題待重切`)
  if (!targets.length) return { reCropped: 0 }

  let reCropped = 0
  let crossPage = 0
  for (const q of targets) {
    const candidates = findCandidatePdfs(exam, q.exam_code)
    if (!candidates.length) { continue }

    let info = null, pageInfo = null
    for (const { dir, file: f } of candidates) {
      try {
        const { pages } = await loadPdf(path.join(dir, f))
        // Find page with this question number
        for (const p of pages) {
          if (findQuestionY(p.page, mupdfMod, q.number) !== null) {
            pageInfo = p; info = { dir, file: f, pages }; break
          }
        }
        if (pageInfo) break
      } catch {}
    }
    if (!pageInfo) { continue }

    try {
      const result = await smartCrop(pageInfo, mupdfMod, q.number, info.file)
      if (!result) continue

      // Write to existing image_url filename (overwrite the loose patrol crop)
      const outName = path.basename(q.image_url)
      const outPath = path.join(IMG_OUT, outName)
      fs.writeFileSync(outPath, result.cropped)

      // Cross-page: also render next page top (until next-next question marker) as _next.webp
      if (result.nextNeeded && pageInfo.idx + 1 < info.pages.length) {
        const nextPage = info.pages[pageInfo.idx + 1]
        const nextBounds = nextPage.bounds
        const nextEnd = findQuestionY(nextPage.page, mupdfMod, q.number + 1)
        const ny0 = nextBounds[1]
        const ny1 = nextEnd !== null ? Math.min(nextBounds[3], nextEnd - 5) : Math.min(nextBounds[3], ny0 + (nextBounds[3] - ny0) * 0.5)

        const matrix = mupdfMod.Matrix.scale(SCALE, SCALE)
        const fullPx = nextPage.page.toPixmap(matrix, mupdfMod.ColorSpace.DeviceRGB, false, true)
        const fullBuf = Buffer.from(fullPx.asPNG())
        const m = await sharp(fullBuf).metadata()
        const ph = nextBounds[3] - nextBounds[1]
        const pxPer = m.height / ph
        const top = Math.round((ny0 - nextBounds[1]) * pxPer)
        const h = Math.round((ny1 - ny0) * pxPer)
        if (h >= 50) {
          // Derive _next name from current image_url
          const baseName = path.basename(q.image_url, '.webp').replace(/_(full|patrol)$/, '')
          const nextOut = `${baseName}_next.webp`
          await sharp(fullBuf).extract({ left: 0, top: Math.max(0, top), width: m.width, height: Math.min(m.height - top, h) })
            .webp({ quality: 82 }).toFile(path.join(IMG_OUT, nextOut))
          crossPage++
        }
      }
      reCropped++
      if (reCropped % 20 === 0) console.log(`  ${reCropped}/${targets.length}...`)
    } catch (e) {
      console.log(`  ✗ Q${q.number} (${q.exam_code}): ${e.message}`)
    }
  }
  console.log(`[${exam}] ✓ ${reCropped} re-cropped (${crossPage} cross-page)`)
  return { reCropped, crossPage }
}

async function main() {
  await getMupdf()
  const exams = isAll ? Object.keys(EXAM_FILES) : (examFilter ? [examFilter] : [])
  if (!exams.length) { console.error('用法: --exam audiologist [--limit 20] 或 --all'); process.exit(1) }
  let total = 0, totalCross = 0
  for (const e of exams) {
    if (e === 'pt' || e === 'ot') continue  // skip
    const r = await processExam(e)
    total += r.reCropped || 0
    totalCross += r.crossPage || 0
  }
  console.log(`\n=== 總計 ${total} 題重切，${totalCross} 題加 _next 跨頁 ===`)
}

main().catch(e => { console.error(e); process.exit(1) })
