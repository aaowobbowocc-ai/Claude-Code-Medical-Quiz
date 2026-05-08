#!/usr/bin/env node
/**
 * Render full PDF page as image for incomplete questions where the options
 * themselves are images (藥材照片、結構式、X 光等)。
 *
 * Result schema for each fixed question:
 *   - image_url: '/question-images/{exam}_{exam_code}_q{number}_full.webp'
 *   - incomplete: 'image_options'  (allowed by isSingleAnswer)
 *   - options.A/B/C/D: '（見附圖選項 X）' — non-empty placeholder so q.options[ans] truthy
 *
 * Usage:
 *   node scripts/render-incomplete-pages.js --dry-run
 *   node scripts/render-incomplete-pages.js --exam=tcm1
 *   node scripts/render-incomplete-pages.js                  (run all)
 */
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE_DIRS = [
  path.join(BACKEND, '_tmp', 'pdf-cache'),
  path.join(BACKEND, '_tmp', 'pdf-cache-100-105'),
]
const PDF_CACHE = PDF_CACHE_DIRS[0]  // legacy alias
const IMG_OUT = path.join(BACKEND, '..', 'frontend', 'public', 'question-images')
const SCALE = 3

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const examFilter = args.find(a => a.startsWith('--exam='))?.split('=')[1] || 'all'

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
}

const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }

const pdfPageCache = {}
async function loadPdfPages(pdfPath) {
  if (pdfPageCache[pdfPath]) return pdfPageCache[pdfPath]
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const pages = []
  const n = doc.countPages()
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i)
    const text = stripPUA(page.toStructuredText('preserve-whitespace').asText())
    pages.push({ page, text, idx: i })
  }
  const result = { doc, pages, mupdf }
  pdfPageCache[pdfPath] = result
  return result
}

function findCandidatePdfs(exam, exam_code) {
  // Walk every cache dir; return [{dir, file}, ...]
  const out = []
  for (const dir of PDF_CACHE_DIRS) {
    if (!fs.existsSync(dir)) continue
    const allFiles = fs.readdirSync(dir).filter(f => f.endsWith('.pdf'))
    for (const f of allFiles) {
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

// Strip whitespace + common punctuation for substring matching.
// NFKC normalize first to handle CJK Compatibility Ideographs
// (e.g. 列 U+F99C in DB → U+5217 in PDF — same glyph, different code point).
const cleanText = s => (s || '').normalize('NFKC').replace(/[\s,，。、．.;；:：?？!！()（）「」『』《》<>《》【】\[\]]/g, '')

async function findPageWithQuestion(pdfPath, qnum, dbQHint) {
  const { pages, mupdf, doc } = await loadPdfPages(pdfPath)
  const patterns = [
    new RegExp(`(?:^|\\n)\\s*${qnum}\\s*[.、．]`),
    new RegExp(`(?:^|\\n)\\s*${qnum}\\s*\\n`),
    new RegExp(`第\\s*${qnum}\\s*題`),
  ]
  const cleanHint = cleanText(dbQHint).slice(0, 10)
  for (const p of pages) {
    for (const re of patterns) {
      if (re.test(p.text)) {
        if (cleanHint && cleanHint.length >= 6) {
          if (!cleanText(p.text).includes(cleanHint.slice(0, 6))) continue
        }
        return { page: p.page, idx: p.idx, mupdf, doc, totalPages: pages.length }
      }
    }
  }
  return null
}

async function renderPageToWebp(page, mupdf, outPath, scale = SCALE) {
  const px = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true)
  const png = Buffer.from(px.asPNG())
  await sharp(png).webp({ quality: 80 }).toFile(outPath)
}

async function processExam(exam) {
  const file = EXAM_FILES[exam]
  if (!file) return { fixed: 0, failed: 0 }
  const fp = path.join(BACKEND, file)
  if (!fs.existsSync(fp)) return { fixed: 0, failed: 0 }
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
  const arr = data.questions || data
  const targets = arr.filter(q => q.incomplete === true)
  if (!targets.length) return { fixed: 0, failed: 0 }

  console.log(`[${exam}] ${targets.length} target(s)`)
  if (dryRun) return { fixed: 0, failed: 0 }

  if (!fs.existsSync(IMG_OUT)) fs.mkdirSync(IMG_OUT, { recursive: true })

  let fixed = 0, failed = 0
  for (const q of targets) {
    // Fast path: already has images extracted (image-dep), just fix schema
    if (q.images && q.images.length) {
      q.incomplete = 'image_options'
      q.options = q.options || {}
      for (const opt of ['A', 'B', 'C', 'D']) {
        if (!q.options[opt] || q.options[opt].length < 2) {
          q.options[opt] = `（見附圖選項 ${opt}）`
        }
      }
      console.log(`  ✓ ${q.id} (${q.exam_code} Q${q.number}) → schema-only fix (already has ${q.images.length} images)`)
      fixed++
      continue
    }
    const dbQHint = (q.question || '').replace(/^\d+[.、．\s]*/, '').trim().slice(0, 30)
    const candidates = findCandidatePdfs(exam, q.exam_code)
    let info = null
    let sourcePdf = null
    let sourceDir = null
    for (const { dir, file: f } of candidates) {
      try {
        info = await findPageWithQuestion(path.join(dir, f), q.number, dbQHint)
        if (info) { sourcePdf = f; sourceDir = dir; break }
      } catch (e) {
        if (process.env.VERBOSE) console.log(`    error ${f}: ${e.message}`)
      }
    }
    if (!info) {
      console.log(`  ✗ ${q.id} (${q.exam_code} Q${q.number}): no PDF page found`)
      failed++
      continue
    }
    const outName = `${exam}_${q.exam_code}_q${q.number}_full.webp`
    const outPath = path.join(IMG_OUT, outName)
    try {
      // Render this page + next page (in case Q spans two pages)
      const pngs = [outPath]
      await renderPageToWebp(info.page, info.mupdf, outPath, SCALE)
      // For pictorial questions, options might span to next page — append _next.webp
      if (info.idx + 1 < info.totalPages) {
        const nextPage = info.doc.loadPage(info.idx + 1)
        const nextOut = path.join(IMG_OUT, `${exam}_${q.exam_code}_q${q.number}_next.webp`)
        // Only render next page if current page text doesn't contain D option marker
        const curText = (await loadPdfPages(path.join(sourceDir, sourcePdf))).pages[info.idx].text
        if (!/(\(D\)|（D）|D[.、．])/.test(curText)) {
          await renderPageToWebp(nextPage, info.mupdf, nextOut, SCALE)
          pngs.push(nextOut)
        }
      }
      // Update question
      q.image_url = '/question-images/' + outName
      q.incomplete = 'image_options'
      q.options = q.options || {}
      for (const opt of ['A', 'B', 'C', 'D']) {
        if (!q.options[opt] || q.options[opt].length < 1) {
          q.options[opt] = `（見附圖選項 ${opt}）`
        }
      }
      console.log(`  ✓ ${q.id} (${q.exam_code} Q${q.number}) → ${outName} (from ${sourcePdf})`)
      fixed++
    } catch (e) {
      console.log(`  ✗ ${q.id}: render error: ${e.message}`)
      failed++
    }
  }

  fs.writeFileSync(fp, JSON.stringify(data, null, 2))
  console.log(`[${exam}] ✓ ${fixed} fixed, ${failed} failed\n`)
  return { fixed, failed }
}

async function main() {
  const exams = examFilter === 'all'
    ? Object.keys(EXAM_FILES)
    : examFilter.split(',')
  console.log(`[render-pictorial] exams=${exams.join(',')} dry=${dryRun}\n`)
  let totalFixed = 0, totalFailed = 0
  for (const e of exams) {
    const { fixed, failed } = await processExam(e)
    totalFixed += fixed
    totalFailed += failed
  }
  console.log(`=== TOTAL: ${totalFixed} fixed, ${totalFailed} failed ===`)
}

main().catch(e => { console.error(e); process.exit(1) })
