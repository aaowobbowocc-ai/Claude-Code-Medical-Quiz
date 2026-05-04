#!/usr/bin/env node
/**
 * Batch image extraction for incomplete questions across multiple exams.
 * No API calls — pure local mupdf rendering + sharp WebP encoding.
 *
 * Strategy:
 *   1. For each exam, find questions with `gap_reason: missing_image | missing_image_dep`.
 *   2. For each (exam_code, subject) group, auto-discover the cached PDF whose
 *      first-page text contains the subject name AND the target question number.
 *   3. Render the page containing the question, save as WebP, set image_url.
 *
 * Run: node scripts/extract-page-images-batch.js [--exam=medlab,dental2,...]
 */

const fs    = require('fs')
const path  = require('path')
const sharp = require('sharp')

const BACKEND   = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')
const IMG_OUT   = path.join(BACKEND, '..', 'frontend', 'public', 'question-images')

const EXAM_FILES = {
  doctor1:    'questions.json',
  doctor2:    'questions-doctor2.json',
  medlab:     'questions-medlab.json',
  dental1:    'questions-dental1.json',
  dental2:    'questions-dental2.json',
  nursing:    'questions-nursing.json',
  pharma1:    'questions-pharma1.json',
  pharma2:    'questions-pharma2.json',
  vet:        'questions-vet.json',
  pt:         'questions-pt.json',
  ot:         'questions-ot.json',
  radiology:  'questions-radiology.json',
  tcm1:       'questions-tcm1.json',
  tcm2:       'questions-tcm2.json',
  nutrition:  'questions-nutrition.json',
  'social-worker': 'questions-social-worker.json',
}

const PAPER_INDEX = {} // examId → { subject → pi (0-based) } from exam-configs

function loadConfig(examId) {
  const cfgFile = path.join(BACKEND, 'exam-configs', `${examId}.json`)
  if (!fs.existsSync(cfgFile)) return null
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  const map = {}
  ;(cfg.papers || []).forEach((p, idx) => {
    if (p.subject) map[p.subject] = idx
    if (p.name && !map[p.name]) map[p.name] = idx
  })
  PAPER_INDEX[examId] = map
  return cfg
}

// ─── PDF helpers ───────────────────────────────────────────────────────────
let mupdfMod
async function getMupdf() {
  if (!mupdfMod) mupdfMod = await import('mupdf')
  return mupdfMod
}

async function readPdfPages(pdfPath) {
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n   = doc.countPages()
  const pages = []
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i)
    const text = page.toStructuredText('preserve-whitespace').asText()
    pages.push({ page, text, idx: i })
  }
  return { doc, pages, mupdf }
}

async function renderPageToWebp(page, mupdf, outPath, dpi = 144) {
  const matrix = mupdf.Matrix.scale(dpi / 72, dpi / 72)
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true)
  const png    = Buffer.from(pixmap.asPNG())
  await sharp(png).webp({ quality: 85 }).toFile(outPath)
}

function findQuestionPage(pages, qnum) {
  const re1 = new RegExp(`(?:^|\\n)\\s*${qnum}[.、．]`)
  const re2 = new RegExp(`(?:^|\\n)\\s*${qnum}\\s*\\n`)
  const re3 = new RegExp(`(?:^|\\n)\\s*${qnum}\\s{2,}[^\\d]`)
  for (let i = 0; i < pages.length; i++) {
    const t = pages[i].text
    if (re1.test(t) || re2.test(t) || re3.test(t)) return i
  }
  return -1
}

// ─── PDF auto-discovery ────────────────────────────────────────────────────
// For (exam, exam_code, subject), find the cached PDF whose first-page
// "科目名稱：" matches the subject. Returns { pdfPath, pages, mupdf } or null.
const pdfCache = {} // path → { pages, mupdf }
async function loadPdfCached(pdfPath) {
  if (pdfCache[pdfPath]) return pdfCache[pdfPath]
  const result = await readPdfPages(pdfPath)
  pdfCache[pdfPath] = result
  return result
}

async function discoverPdf(exam, exam_code, subject, sampleQs, allArr) {
  const prefix = `${exam}_${exam_code}_`
  const candidates = fs.readdirSync(PDF_CACHE).filter(f => f.startsWith(prefix) && f.endsWith('.pdf'))
  // Strategy 1: subject literal match on first page (works for medlab, vet, etc.)
  for (const f of candidates) {
    const pdfPath = path.join(PDF_CACHE, f)
    const { pages, mupdf } = await loadPdfCached(pdfPath)
    if (pages[0].text.includes(subject)) {
      return { pdfPath, pages, mupdf, file: f }
    }
  }
  // Strategy 2: question content match — find any other question in the same
  // (exam_code, subject) group that has non-trivial text, search across
  // candidate PDFs for that text. Only ONE PDF should contain it.
  const sameGroup = allArr.filter(q =>
    q.exam_code === exam_code && q.subject === subject &&
    q.question && q.question.length >= 30 && !q.incomplete
  )
  if (sameGroup.length === 0) return null
  // Pick a distinctive snippet (Chinese chars only, 12 chars) from a complete sibling
  const probeQ = sameGroup[Math.floor(sameGroup.length / 2)]
  const snippet = (probeQ.question.match(/[一-鿿]+/g) || [])
    .find(s => s.length >= 12)?.substring(0, 12)
  if (!snippet) return null
  for (const f of candidates) {
    const pdfPath = path.join(PDF_CACHE, f)
    const { pages, mupdf } = await loadPdfCached(pdfPath)
    if (pages.some(p => p.text.includes(snippet))) {
      return { pdfPath, pages, mupdf, file: f }
    }
  }
  return null
}

// ─── Main batch processing ─────────────────────────────────────────────────
async function processExam(examId) {
  const file = EXAM_FILES[examId]
  if (!file) { console.log(`unknown exam: ${examId}`); return 0 }
  loadConfig(examId)
  const filePath = path.join(BACKEND, file)
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const arr = raw.questions || raw

  const targets = arr.filter(q =>
    q.incomplete &&
    (q.gap_reason === 'missing_image' || q.gap_reason === 'missing_image_dep') &&
    !q.image_url
  )
  if (targets.length === 0) { console.log(`${examId}: no targets`); return 0 }

  // Group by (exam_code, subject) for batched PDF loading
  const groups = {}
  for (const q of targets) {
    const k = `${q.exam_code}|${q.subject}`
    if (!groups[k]) groups[k] = []
    groups[k].push(q)
  }
  console.log(`\n=== ${examId} (${targets.length} targets, ${Object.keys(groups).length} groups) ===`)

  let patched = 0
  for (const [groupKey, qs] of Object.entries(groups)) {
    const [exam_code, subject] = groupKey.split('|')
    const found = await discoverPdf(examId, exam_code, subject, qs, arr)
    if (!found) {
      console.log(`  ✗ ${groupKey}: no PDF found`)
      continue
    }
    console.log(`  ${groupKey} → ${found.file}`)

    const pi = PAPER_INDEX[examId]?.[subject] ?? 0

    for (const q of qs) {
      const pageIdx = findQuestionPage(found.pages, q.number)
      if (pageIdx < 0) {
        console.log(`    ✗ Q${q.number}: page not found`)
        continue
      }
      const imgName = `${examId}_${q.exam_code}_p${pi}_${q.number}_0.webp`
      const imgPath = path.join(IMG_OUT, imgName)
      await renderPageToWebp(found.pages[pageIdx].page, found.mupdf, imgPath)

      const targetIdx = arr.findIndex(x =>
        x.exam_code === q.exam_code && x.subject === q.subject && x.number === q.number
      )
      if (targetIdx < 0) { console.log(`    ✗ Q${q.number}: not in JSON`); continue }
      arr[targetIdx].image_url = `/question-images/${imgName}`
      delete arr[targetIdx].incomplete
      delete arr[targetIdx].gap_reason
      patched++
      console.log(`    ✓ Q${q.number} page ${pageIdx + 1} → ${imgName}`)
    }
  }

  if (patched > 0) {
    const toSave = raw.questions ? raw : arr
    fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2))
    console.log(`  💾 ${file} (${patched} patched)`)
  }
  return patched
}

async function main() {
  const argExam = process.argv.find(a => a.startsWith('--exam='))?.slice(7)
  const exams = argExam ? argExam.split(',') : Object.keys(EXAM_FILES)
  let total = 0
  for (const examId of exams) {
    total += await processExam(examId)
  }
  console.log(`\n總計: ${total} questions patched`)
}

main().catch(e => { console.error(e); process.exit(1) })
