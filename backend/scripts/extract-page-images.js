#!/usr/bin/env node
/**
 * Extract full-page images for remaining incomplete questions.
 * No AI API calls — pure local mupdf rendering.
 *
 * For each target question:
 *   1. Load cached PDF (all already cached from previous scrape runs)
 *   2. Find the page containing the question by text search
 *   3. Render the full page at 144 DPI → save as WebP
 *   4. Update JSON: set image_url, update incomplete flag
 *
 * Question types handled:
 *   missing_image     — doctor1: question references embedded image
 *   missing_image_dep — doctor2: question references a figure
 *   empty_options     — doctor2: options are images (set incomplete='image_options')
 */

const fs    = require('fs')
const path  = require('path')
const sharp = require('sharp')

const BACKEND   = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')
const IMG_OUT   = path.join(BACKEND, '..', 'frontend', 'public', 'question-images')

// ─── PDF loading ───────────────────────────────────────────────────────────
function loadCachedPdf(exam, code, c, s) {
  const fpath = path.join(PDF_CACHE, `${exam}_${code}_c${c}_s${s}.pdf`)
  if (!fs.existsSync(fpath)) throw new Error(`Cache miss: ${fpath}`)
  const buf = fs.readFileSync(fpath)
  console.log(`  Loaded: ${path.basename(fpath)} (${buf.length} bytes)`)
  return buf
}

// ─── PDF → pages (text + PNG) ─────────────────────────────────────────────
async function extractPages(buf, dpi = 144) {
  const mupdf = await import('mupdf')
  const doc   = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n     = doc.countPages()
  const scale = dpi / 72
  const pages = []
  for (let i = 0; i < n; i++) {
    const page   = doc.loadPage(i)
    const st     = page.toStructuredText('preserve-whitespace')
    const text   = st.asText()
    const matrix = mupdf.Matrix.scale(scale, scale)
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true)
    const png    = Buffer.from(pixmap.asPNG())
    pages.push({ text, png })
  }
  console.log(`  ${n} pages extracted`)
  return pages
}

// ─── Page finding ─────────────────────────────────────────────────────────
function findPage(pages, qnum) {
  // re1: "N." / "N、" / "N．" — standard punctuated question number
  const re1 = new RegExp(`(?:^|\\n)\\s*${qnum}[.、．]`)
  // re2: number alone on its own line (followed by newline/spaces+newline)
  const re2 = new RegExp(`(?:^|\\n)\\s*${qnum}\\s*\\n`)
  // re3: old doctor1 c=101 space-separated format — requires 2+ spaces to
  //      avoid false positives like "4\n54 歲男性" matching as Q54
  const re3 = new RegExp(`(?:^|\\n)\\s*${qnum}\\s{2,}[^\\d]`)
  for (let i = 0; i < pages.length; i++) {
    const t = pages[i].text
    if (re1.test(t) || re2.test(t) || re3.test(t)) return i
  }
  return -1
}

// ─── Image saving ─────────────────────────────────────────────────────────
async function saveWebp(pngBuf, filename) {
  await sharp(pngBuf).webp({ quality: 85 }).toFile(filename)
}

// ─── Target definitions ───────────────────────────────────────────────────
// type: 'missing_image'     → set image_url, clear incomplete/gap_reason
// type: 'missing_image_dep' → set image_url, clear incomplete/gap_reason
// type: 'empty_options'     → set image_url, set incomplete='image_options',
//                             fill any empty option values with their key
const PAPERS = [
  // ── doctor1: 醫學(二) pi=1 ────────────────────────────────────────────
  {
    exam: 'doctor1', file: 'questions.json', structKey: 'questions',
    code: '101030', c: '101', s: '0102',
    targets: [{ exam_code: '101030', subject: '醫學(二)', number: 98, pi: 1, type: 'missing_image' }],
  },
  {
    exam: 'doctor1', file: 'questions.json', structKey: 'questions',
    code: '104030', c: '101', s: '0102',
    targets: [{ exam_code: '104030', subject: '醫學(二)', number: 92, pi: 1, type: 'missing_image' }],
  },
  {
    exam: 'doctor1', file: 'questions.json', structKey: 'questions',
    code: '101110', c: '101', s: '0102',
    targets: [{ exam_code: '101110', subject: '醫學(二)', number: 76, pi: 1, type: 'missing_image' }],
  },
  {
    exam: 'doctor1', file: 'questions.json', structKey: 'questions',
    code: '102110', c: '101', s: '0102',
    targets: [
      { exam_code: '102110', subject: '醫學(二)', number: 79,  pi: 1, type: 'missing_image' },
      { exam_code: '102110', subject: '醫學(二)', number: 94,  pi: 1, type: 'missing_image' },
      { exam_code: '102110', subject: '醫學(二)', number: 100, pi: 1, type: 'missing_image' },
    ],
  },
  // ── doctor2: missing_image_dep ─────────────────────────────────────────
  {
    exam: 'doctor2', file: 'questions-doctor2.json', structKey: 'questions',
    code: '115020', c: '302', s: '0106',
    targets: [{ exam_code: '115020', subject: '醫學(六)', number: 73, pi: 3, type: 'missing_image_dep' }],
  },
  {
    exam: 'doctor2', file: 'questions-doctor2.json', structKey: 'questions',
    code: '107080', c: '302', s: '11',
    targets: [{ exam_code: '107080', subject: '醫學(三)', number: 39, pi: 0, type: 'missing_image_dep' }],
  },
  {
    exam: 'doctor2', file: 'questions-doctor2.json', structKey: 'questions',
    code: '102030', c: '102', s: '0103',
    targets: [
      { exam_code: '102030', subject: '醫學(三)', number: 54, pi: 0, type: 'missing_image_dep' },
      { exam_code: '102030', subject: '醫學(三)', number: 63, pi: 0, type: 'missing_image_dep' },
      { exam_code: '102030', subject: '醫學(三)', number: 69, pi: 0, type: 'missing_image_dep' },
      { exam_code: '102030', subject: '醫學(三)', number: 70, pi: 0, type: 'missing_image_dep' },
    ],
  },
  {
    exam: 'doctor2', file: 'questions-doctor2.json', structKey: 'questions',
    code: '103030', c: '102', s: '0103',
    targets: [{ exam_code: '103030', subject: '醫學(三)', number: 77, pi: 0, type: 'missing_image_dep' }],
  },
  {
    exam: 'doctor2', file: 'questions-doctor2.json', structKey: 'questions',
    code: '103030', c: '102', s: '0104',
    targets: [{ exam_code: '103030', subject: '醫學(四)', number: 37, pi: 1, type: 'missing_image_dep' }],
  },
  {
    exam: 'doctor2', file: 'questions-doctor2.json', structKey: 'questions',
    code: '103100', c: '102', s: '0104',
    targets: [{ exam_code: '103100', subject: '醫學(四)', number: 34, pi: 1, type: 'missing_image_dep' }],
  },
  // ── doctor2: empty_options (options are images) ────────────────────────
  {
    exam: 'doctor2', file: 'questions-doctor2.json', structKey: 'questions',
    code: '109080', c: '302', s: '44',
    targets: [{ exam_code: '109080', subject: '醫學(六)', number: 26, pi: 3, type: 'empty_options' }],
  },
  {
    exam: 'doctor2', file: 'questions-doctor2.json', structKey: 'questions',
    code: '105020', c: '302', s: '33',
    targets: [{ exam_code: '105020', subject: '醫學(五)', number: 9, pi: 2, type: 'empty_options' }],
  },
  {
    exam: 'doctor2', file: 'questions-doctor2.json', structKey: 'questions',
    code: '101110', c: '102', s: '0105',
    targets: [{ exam_code: '101110', subject: '醫學(五)', number: 72, pi: 2, type: 'empty_options' }],
  },
  {
    exam: 'doctor2', file: 'questions-doctor2.json', structKey: 'questions',
    code: '101110', c: '102', s: '0106',
    targets: [{ exam_code: '101110', subject: '醫學(六)', number: 72, pi: 3, type: 'empty_options' }],
  },
]

// ─── Process one paper group ───────────────────────────────────────────────
async function processPaper(paper) {
  console.log(`\n═══ ${paper.exam} ${paper.code} s=${paper.s} ═══`)
  const buf   = loadCachedPdf(paper.exam, paper.code, paper.c, paper.s)
  const pages = await extractPages(buf)

  const filePath = path.join(BACKEND, paper.file)
  const raw      = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const arr      = raw[paper.structKey] || raw
  let patched    = 0

  for (const tgt of paper.targets) {
    const pageIdx = findPage(pages, tgt.number)
    if (pageIdx < 0) {
      console.log(`  ✗ Q${tgt.number}: page not found`)
      continue
    }
    console.log(`  Q${tgt.number}: page ${pageIdx + 1}`)

    const imgName = `${paper.exam}_${tgt.exam_code}_p${tgt.pi}_${tgt.number}_0.webp`
    const imgPath = path.join(IMG_OUT, imgName)
    await saveWebp(pages[pageIdx].png, imgPath)
    console.log(`    → ${imgName}`)

    const idx = arr.findIndex(
      q => q.exam_code === tgt.exam_code && q.subject === tgt.subject && q.number === tgt.number
    )
    if (idx < 0) { console.log(`    ✗ Not in JSON`); continue }

    const q      = arr[idx]
    q.image_url  = `/question-images/${imgName}`

    if (tgt.type === 'empty_options') {
      q.incomplete = 'image_options'
      for (const [k, v] of Object.entries(q.options)) {
        if (!v) q.options[k] = k
      }
    } else {
      delete q.incomplete
      delete q.gap_reason
    }
    patched++
  }

  if (patched > 0) {
    const toSave = paper.structKey ? raw : arr
    fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2))
    console.log(`  💾 ${paper.file} (${patched} patched)`)
  }
  return patched
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  let total = 0
  for (const paper of PAPERS) {
    total += await processPaper(paper)
  }
  console.log(`\n總計: ${total} questions patched`)
}

main().catch(e => { console.error(e); process.exit(1) })
