#!/usr/bin/env node
/**
 * 重新精準裁切已有 image_url 的題目，只裁該題範圍。
 * 改進版：
 *   1. PDF 候選須驗類科名稱 — 避免 audiologist 抓到醫師 PDF
 *   2. 空白裁片自動拒絕 — 避免 next.webp < 5KB 噪音
 *   3. 跨頁自動加 _next.webp
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
const SCALE = 3

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

const EXPECTED_EXAM_NAMES = {
  doctor1: '醫師', doctor2: '醫師',
  dental1: '牙醫師', dental2: '牙醫師',
  pharma1: '藥師', pharma2: '藥師',
  medlab: '醫事檢驗師', radiology: '醫事放射師',
  pt: '物理治療師', ot: '職能治療師',
  nursing: '護理師', nutrition: '營養師',
  tcm1: '中醫師', tcm2: '中醫師',
  vet: '獸醫師',
  audiologist: '聽力師',
  'speech-therapist': '語言治療師',
  rt: '呼吸治療師',
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
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.pdf')) continue
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
    const bounds = page.getBounds()
    pages.push({ page, text, idx: i, bounds })
  }
  // 抓「類科」(first page) for validation
  const klass = pages[0]?.text.match(/類\s*科[：:名稱]*\s*([^\s\n（(]{2,15})/)?.[1]?.trim() || ''
  const result = { doc, pages, mupdf, klass }
  pdfCache[pdfPath] = result
  return result
}

function pdfMatchesExam(loaded, examId) {
  const expect = EXPECTED_EXAM_NAMES[examId]
  if (!expect || !loaded?.klass) return true
  return loaded.klass.includes(expect)
}

async function isCropBlank(buf, threshold = 0.02) {
  try {
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true })
    const total = info.width * info.height
    let nonWhite = 0
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) nonWhite++
    }
    return (nonWhite / total) < threshold
  } catch { return false }
}

function findQuestionY(page, mupdf, qnum) {
  const stJson = JSON.parse(page.toStructuredText('preserve-whitespace').asJSON())
  for (const block of (stJson.blocks || [])) {
    if (!block.lines) continue
    for (const line of block.lines) {
      const t = (line.text || '').replace(/^\s+/, '')
      const re = new RegExp(`^${qnum}(?:[.、．]|\\s)`)
      if (re.test(t)) return line.bbox?.y ?? null
    }
  }
  return null
}

async function smartCrop(pageInfo, mupdf, qnum) {
  const ystart = findQuestionY(pageInfo.page, mupdf, qnum)
  if (ystart === null) return null
  const yend = findQuestionY(pageInfo.page, mupdf, qnum + 1)
  const bounds = pageInfo.bounds
  const padTop = 5, padBot = 5
  const cropY0 = Math.max(bounds[1], ystart - padTop)
  const cropY1 = yend !== null ? Math.min(bounds[3], yend - padBot) : bounds[3]

  const matrix = mupdf.Matrix.scale(SCALE, SCALE)
  const fullPx = pageInfo.page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true)
  const fullBuf = Buffer.from(fullPx.asPNG())
  const meta = await sharp(fullBuf).metadata()
  const pdfH = bounds[3] - bounds[1]
  const pxPer = meta.height / pdfH
  const top = Math.round((cropY0 - bounds[1]) * pxPer)
  const cropH = Math.round((cropY1 - cropY0) * pxPer)
  if (cropH < 50) return null

  return {
    cropped: await sharp(fullBuf).extract({
      left: 0, top: Math.max(0, top), width: meta.width,
      height: Math.min(meta.height - top, cropH),
    }).webp({ quality: 82 }).toBuffer(),
    nextNeeded: yend === null,
  }
}

async function processExam(exam) {
  const file = EXAM_FILES[exam]
  if (!file) return { reCropped: 0, blank: 0, noPdf: 0, mismatch: 0 }
  const fp = path.join(BACKEND, file)
  if (!fs.existsSync(fp)) return { reCropped: 0, blank: 0, noPdf: 0, mismatch: 0 }
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data

  const targets = arr.filter(q =>
    q.image_url &&
    /\/question-images\/[^/]+_q\d+(?:_full|_patrol|_next)?\.webp$/.test(q.image_url)
  )
  if (limit > 0) targets.splice(limit)
  console.log(`\n[${exam}] ${targets.length} 題待重切`)
  if (!targets.length) return { reCropped: 0, blank: 0, noPdf: 0, mismatch: 0 }

  let reCropped = 0, blank = 0, noPdf = 0, mismatch = 0, crossPage = 0, crossBlank = 0
  for (const q of targets) {
    const candidates = findCandidatePdfs(exam, q.exam_code)
    if (!candidates.length) { noPdf++; continue }

    let info = null, pageInfo = null
    let triedAndMismatched = false
    for (const { dir, file: f } of candidates) {
      try {
        const loaded = await loadPdf(path.join(dir, f))
        if (!pdfMatchesExam(loaded, exam)) { triedAndMismatched = true; continue }
        for (const p of loaded.pages) {
          if (findQuestionY(p.page, mupdfMod, q.number) !== null) {
            pageInfo = p; info = { dir, file: f, pages: loaded.pages }; break
          }
        }
        if (pageInfo) break
      } catch {}
    }
    if (!pageInfo) {
      if (triedAndMismatched && !info) mismatch++
      continue
    }

    try {
      const result = await smartCrop(pageInfo, mupdfMod, q.number)
      if (!result) continue
      if (await isCropBlank(result.cropped)) { blank++; continue }

      const outName = path.basename(q.image_url)
      fs.writeFileSync(path.join(IMG_OUT, outName), result.cropped)

      if (result.nextNeeded && pageInfo.idx + 1 < info.pages.length) {
        const nextPage = info.pages[pageInfo.idx + 1]
        const nb = nextPage.bounds
        const nextEnd = findQuestionY(nextPage.page, mupdfMod, q.number + 1)
        const ny0 = nb[1]
        const ny1 = nextEnd !== null ? Math.min(nb[3], nextEnd - 5) : Math.min(nb[3], ny0 + (nb[3] - ny0) * 0.5)
        const matrix = mupdfMod.Matrix.scale(SCALE, SCALE)
        const fullPx = nextPage.page.toPixmap(matrix, mupdfMod.ColorSpace.DeviceRGB, false, true)
        const fullBuf = Buffer.from(fullPx.asPNG())
        const m = await sharp(fullBuf).metadata()
        const ph = nb[3] - nb[1]
        const pxPer = m.height / ph
        const top = Math.round((ny0 - nb[1]) * pxPer)
        const h = Math.round((ny1 - ny0) * pxPer)
        if (h >= 50) {
          const nextBuf = await sharp(fullBuf).extract({
            left: 0, top: Math.max(0, top), width: m.width, height: Math.min(m.height - top, h)
          }).webp({ quality: 82 }).toBuffer()
          if (await isCropBlank(nextBuf)) { crossBlank++ }
          else {
            const baseName = path.basename(q.image_url, '.webp').replace(/_(full|patrol)$/, '')
            fs.writeFileSync(path.join(IMG_OUT, `${baseName}_next.webp`), nextBuf)
            crossPage++
          }
        }
      }
      reCropped++
      if (reCropped % 30 === 0) console.log(`  ${reCropped}/${targets.length}...`)
    } catch (e) {
      console.log(`  ✗ Q${q.number} (${q.exam_code}): ${e.message}`)
    }
  }
  console.log(`[${exam}] ✓ ${reCropped} re-cropped (${crossPage} cross-page, ${crossBlank} blank-skip-next, ${blank} blank-skip-self, ${noPdf} no-pdf, ${mismatch} pdf-mismatch)`)
  return { reCropped, blank, noPdf, mismatch }
}

async function main() {
  await getMupdf()
  const exams = isAll ? Object.keys(EXAM_FILES) : (examFilter ? [examFilter] : [])
  if (!exams.length) { console.error('用法: --exam audiologist [--limit 20] 或 --all'); process.exit(1) }
  let total = 0, totalBlank = 0, totalNoPdf = 0, totalMismatch = 0
  for (const e of exams) {
    if (e === 'pt' || e === 'ot') continue
    const r = await processExam(e)
    total += r.reCropped || 0
    totalBlank += r.blank || 0
    totalNoPdf += r.noPdf || 0
    totalMismatch += r.mismatch || 0
  }
  console.log(`\n=== 總計 ${total} 題重切，跳過 ${totalBlank} 空白、${totalNoPdf} 無 PDF、${totalMismatch} PDF 類科不符 ===`)
}

main().catch(e => { console.error(e); process.exit(1) })
