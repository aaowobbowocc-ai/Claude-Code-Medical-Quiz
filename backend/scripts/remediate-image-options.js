#!/usr/bin/env node
/**
 * 依 _tmp/image-options-audit.json 的分類結果，把 70 題圖選項題分別補完。
 *
 * Type A (4_image_options): 用 boxes sharp 裁 4 張 → option_images，options.A-D='(圖)'，刪 image_url, incomplete
 * Type B (single_image_text_options): 用 options_text 還原文字，保留 image_url，刪 incomplete
 * Type N (no_image_needed): 用 options_text 還原，刪 image_url 跟 incomplete
 * Type C (cross_page): 暫時當 type B 處理（保留圖、有文字選項就還原）
 *
 * Usage:
 *   node scripts/remediate-image-options.js --dry-run
 *   node scripts/remediate-image-options.js
 */
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')
const IMG_OUT = path.join(BACKEND, '..', 'frontend', 'public', 'question-images')
const AUDIT_FILE = path.join(BACKEND, '_tmp', 'image-options-audit.json')
const SCALE = 3  // must match audit script SCALE

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

const EXAM_FILES = {
  doctor1: 'questions.json', doctor2: 'questions-doctor2.json',
  dental1: 'questions-dental1.json', dental2: 'questions-dental2.json',
  pharma1: 'questions-pharma1.json', pharma2: 'questions-pharma2.json',
  nursing: 'questions-nursing.json', nutrition: 'questions-nutrition.json',
  medlab: 'questions-medlab.json', pt: 'questions-pt.json', ot: 'questions-ot.json',
  radiology: 'questions-radiology.json', tcm1: 'questions-tcm1.json',
  tcm2: 'questions-tcm2.json', vet: 'questions-vet.json',
}

const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')
const cleanText = s => (s || '').normalize('NFKC').replace(/[\s,，。、．.;；:：?？!！()（）「」『』《》<>《》【】\[\]]/g, '')

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }

function findCandidatePdfs(exam, exam_code) {
  const allFiles = fs.readdirSync(PDF_CACHE).filter(f => f.endsWith('.pdf'))
  return allFiles.filter(f => {
    if (/^(TM|TS|M|S|A|TA)_/.test(f)) return false
    if (f.startsWith(`${exam}_${exam_code}_`)) return true
    if (new RegExp(`(?:^|_)Q_${exam_code}_c\\d+_s`).test(f)) return true
    if (new RegExp(`^[A-Za-z\\-]+_Q_${exam_code}_c\\d+_s`).test(f)) return true
    return false
  })
}

async function renderPagePng(pdfPath, qnum, dbQHint) {
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n = doc.countPages()
  const patterns = [
    new RegExp(`(?:^|\\n)\\s*${qnum}\\s*[.、．]`),
    new RegExp(`(?:^|\\n)\\s*${qnum}\\s*\\n`),
    new RegExp(`第\\s*${qnum}\\s*題`),
  ]
  const cleanHint = cleanText(dbQHint).slice(0, 10)
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i)
    const text = stripPUA(page.toStructuredText('preserve-whitespace').asText())
    for (const re of patterns) {
      if (re.test(text)) {
        if (cleanHint && cleanHint.length >= 6) {
          if (!cleanText(text).includes(cleanHint.slice(0, 6))) continue
        }
        const px = page.toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceRGB, false, true)
        return { pngBuf: Buffer.from(px.asPNG()) }
      }
    }
  }
  return null
}

async function findPdfPagePng(exam, q) {
  const dbQHint = (q.question || '').replace(/^\d+[.、．\s]*/, '').trim().slice(0, 30)
  const candidates = findCandidatePdfs(exam, q.exam_code)
  for (const f of candidates) {
    try {
      const result = await renderPagePng(path.join(PDF_CACHE, f), q.number, dbQHint)
      if (result) return { ...result, sourcePdf: f }
    } catch {}
  }
  return null
}

async function cropFromPng(pngBuf, box) {
  const meta = await sharp(pngBuf).metadata()
  const W = meta.width, H = meta.height
  const [ymin, xmin, ymax, xmax] = box
  const left = Math.max(0, Math.round(xmin / 1000 * W))
  const top = Math.max(0, Math.round(ymin / 1000 * H))
  const right = Math.min(W, Math.round(xmax / 1000 * W))
  const bottom = Math.min(H, Math.round(ymax / 1000 * H))
  const width = right - left
  const height = bottom - top
  if (width < 20 || height < 20) throw new Error(`bbox too small: ${width}x${height}`)
  return await sharp(pngBuf)
    .extract({ left, top, width, height })
    .webp({ quality: 85 })
    .toBuffer()
}

function validOptionsText(t) {
  if (!t || typeof t !== 'object') return false
  for (const o of ['A','B','C','D']) {
    if (typeof t[o] !== 'string' || t[o].length < 1) return false
  }
  return true
}

async function main() {
  const audit = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'))
  // Group by exam for batch update
  const examGroups = {}
  for (const [key, info] of Object.entries(audit)) {
    if (info.error) continue
    if (!info.type) continue
    examGroups[info.exam] = examGroups[info.exam] || []
    examGroups[info.exam].push(info)
  }

  const stats = { A: 0, B: 0, N: 0, C: 0, failed: 0 }

  if (!fs.existsSync(IMG_OUT)) fs.mkdirSync(IMG_OUT, { recursive: true })

  for (const [exam, items] of Object.entries(examGroups)) {
    const file = EXAM_FILES[exam]
    if (!file) continue
    const fp = path.join(BACKEND, file)
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
    const arr = data.questions || data
    const idMap = new Map(arr.map(q => [q.id, q]))

    for (const info of items) {
      const q = idMap.get(info.id)
      if (!q) { stats.failed++; continue }

      try {
        if (info.type === '4_image_options') {
          const boxes = info.boxes
          if (!boxes || !['A','B','C','D'].every(o => Array.isArray(boxes[o]) && boxes[o].length === 4)) {
            throw new Error('invalid boxes')
          }
          if (!dryRun) {
            const rendered = await findPdfPagePng(exam, q)
            if (!rendered) throw new Error('PDF page not found for crop')
            const option_images = {}
            for (const letter of ['A','B','C','D']) {
              const cropBuf = await cropFromPng(rendered.pngBuf, boxes[letter])
              const outName = `${exam}_${q.exam_code}_q${q.number}_opt_${letter}.webp`
              fs.writeFileSync(path.join(IMG_OUT, outName), cropBuf)
              option_images[letter] = '/question-images/' + outName
            }
            q.option_images = option_images
            q.options = { A: '(圖)', B: '(圖)', C: '(圖)', D: '(圖)' }
            delete q.image_url
            delete q.incomplete
            delete q.gap_reason
          }
          stats.A++
          console.log(`  [A] ${exam}:${q.id} (${q.exam_code} Q${q.number}) cropped 4 images`)

        } else if (info.type === 'single_image_text_options') {
          if (!validOptionsText(info.options_text)) throw new Error('invalid options_text')
          if (!dryRun) {
            q.options = { ...info.options_text }
            // image_url stays (stem reference image)
            delete q.incomplete
            delete q.gap_reason
          }
          stats.B++
          console.log(`  [B] ${exam}:${q.id} restored text options + kept image_url`)

        } else if (info.type === 'no_image_needed') {
          if (!validOptionsText(info.options_text)) throw new Error('invalid options_text')
          if (!dryRun) {
            q.options = { ...info.options_text }
            delete q.image_url
            delete q.incomplete
            delete q.gap_reason
          }
          stats.N++
          console.log(`  [N] ${exam}:${q.id} restored text options + removed image_url`)

        } else if (info.type === 'cross_page') {
          // Treat like single_image_text_options if options_text exists,
          // otherwise leave alone (manual case)
          if (validOptionsText(info.options_text)) {
            if (!dryRun) {
              q.options = { ...info.options_text }
              delete q.incomplete
              delete q.gap_reason
            }
            stats.C++
            console.log(`  [C] ${exam}:${q.id} cross_page → restored text options`)
          } else {
            console.log(`  [C SKIP] ${exam}:${q.id} cross_page no options_text — manual`)
            stats.failed++
          }
        }
      } catch (e) {
        console.log(`  ✗ ${exam}:${q.id}: ${e.message}`)
        stats.failed++
      }
    }

    if (!dryRun) {
      fs.writeFileSync(fp, JSON.stringify(data, null, 2))
      console.log(`  → wrote ${file}`)
    }
  }

  console.log(`\n=== STATS ===`)
  console.log(`  A (4 image options, cropped): ${stats.A}`)
  console.log(`  B (single image + text options, restored text): ${stats.B}`)
  console.log(`  N (no image, removed image_url + restored text): ${stats.N}`)
  console.log(`  C (cross page, restored): ${stats.C}`)
  console.log(`  failed: ${stats.failed}`)
}

main().catch(e => { console.error(e); process.exit(1) })
