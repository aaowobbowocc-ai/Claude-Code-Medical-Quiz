#!/usr/bin/env node
/**
 * Patrol fix: for each flagged question in _tmp/patrol-scan.json, attempt repair.
 *
 * Strategy by category tag:
 *   missing_image     → render PDF page → /question-images/{exam}_{code}_q{n}_patrol.webp
 *                       set image_url; do NOT touch options or set incomplete
 *   empty_options:*   → use Vertex Vision OCR to fill the empty letter(s)
 *   truly_broken      → use Vertex Vision OCR (full re-extract)
 *   cross_contam      → use Vertex Vision OCR (full re-extract, replace question)
 *
 * NEVER downloads new PDFs (uses _tmp/pdf-cache + _tmp/pdf-cache-100-105 only).
 * Atomic save every 10 patches.
 *
 * Usage:
 *   node scripts/patrol-fix.js --dry-run            (only show plan)
 *   node scripts/patrol-fix.js                      (run all)
 *   node scripts/patrol-fix.js --cat=missing_image  (one category)
 *   node scripts/patrol-fix.js --cat=empty_options
 *   node scripts/patrol-fix.js --exam=tcm1
 *   node scripts/patrol-fix.js --limit=20
 */
require('dotenv/config')
const fs   = require('fs')
const path = require('path')
const sharp = require('sharp')
const { GoogleAuth } = require('google-auth-library')

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE_DIRS = [
  path.join(BACKEND, '_tmp', 'pdf-cache'),
  path.join(BACKEND, '_tmp', 'pdf-cache-100-105'),
]
const IMG_OUT = path.join(BACKEND, '..', 'frontend', 'public', 'question-images')

// Vertex
const VERTEX_PROJECT = 'gen-lang-client-0502672630'
const VERTEX_REGION  = 'us-central1'
// MODEL: gemini-2.5-flash (changed 2026-05-23 from gemini-2.5-pro)
//   OCR / Vision 任務不需要 Pro 推理；Flash 同準確度但便宜 ~17-33 倍。
//   5/22 batch 跑 Pro thinking 一次燒 $200+，Flash 同 batch 約 $5-10。
//   若特殊題目 Flash 結果不佳，再針對該批改回 'gemini-2.5-pro'。
const VERTEX_MODEL   = 'gemini-2.5-flash'
const vertexAuth     = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const SKIP_FILES = new Set(['questions-pt.json', 'questions-ot.json'])

const EXAM_FILES = {
  doctor1:           'questions.json',
  doctor2:           'questions-doctor2.json',
  dental1:           'questions-dental1.json',
  dental2:           'questions-dental2.json',
  pharma1:           'questions-pharma1.json',
  pharma2:           'questions-pharma2.json',
  nursing:           'questions-nursing.json',
  nutrition:         'questions-nutrition.json',
  medlab:            'questions-medlab.json',
  radiology:         'questions-radiology.json',
  rt:                'questions-rt.json',
  tcm1:              'questions-tcm1.json',
  tcm2:              'questions-tcm2.json',
  vet:               'questions-vet.json',
  customs:           'questions-customs.json',
  judicial:          'questions-judicial.json',
  lawyer1:           'questions-lawyer1.json',
  'civil-senior':    'questions-civil-senior.json',
  'social-worker':   'questions-social-worker.json',
  police:            'questions-police.json',
  police4:           'questions-police4.json',
  audiologist:       'questions-audiologist.json',
  'speech-therapist':'questions-speech-therapist.json',
  ast:               'questions-ast.json',
  gsat:              'questions-gsat.json',
  'driver-car':      'questions-driver-car.json',
  'driver-moto':     'questions-driver-moto.json',
  'driver-moto-hazard': 'questions-driver-moto-hazard.json',
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const onlyCat = args.find(a => a.startsWith('--cat='))?.split('=')[1] || null
const onlyExam = args.find(a => a.startsWith('--exam='))?.split('=')[1] || null
const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10)
const noVision = args.includes('--no-vision')

function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')
const cleanText = s => stripPUA(s||'').replace(/[\s,，。、．.;；:：?？!！()（）「」『』《》<>《》【】\[\]]/g,'')

// ─── PDF cache + page lookup ────────────────────────────────────────────
let mupdfMod
async function getMupdf(){ if(!mupdfMod) mupdfMod=await import('mupdf'); return mupdfMod }

const pdfPageCache = {}
async function loadPdfPages(pdfPath) {
  if (pdfPageCache[pdfPath]) return pdfPageCache[pdfPath]
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const pages = []
  const n = doc.countPages()
  for (let i = 0; i < n; i++) {
    const p = doc.loadPage(i)
    const text = stripPUA(p.toStructuredText('preserve-whitespace').asText())
    pages.push({ page: p, text, idx: i })
  }
  const result = { doc, pages, mupdf }
  pdfPageCache[pdfPath] = result
  return result
}

function findCandidatePdfs(exam, exam_code) {
  const out = []
  for (const dir of PDF_CACHE_DIRS) {
    if (!fs.existsSync(dir)) continue
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.pdf'))
    for (const f of files) {
      // Skip answer-only PDFs
      if (/^(TM|TS|M|S|A|TA)_/.test(f)) continue
      const matchesPrefixed = f.startsWith(`${exam}_${exam_code}_`)
      const matchesQ = new RegExp(`(?:^|_)Q_${exam_code}_c\\d+_s`).test(f)
      const matchesQPrefix = new RegExp(`^Q_${exam_code}_c\\d+_s`).test(f)
      if (matchesPrefixed || matchesQ || matchesQPrefix) {
        out.push({ dir, file: f })
      }
    }
  }
  return out
}

async function findPageWithQuestion(pdfPath, qnum, dbQHint) {
  const { pages, mupdf, doc } = await loadPdfPages(pdfPath)
  const patterns = [
    new RegExp(`(?:^|\\n)\\s*${qnum}\\s*[.、．]`),
    new RegExp(`(?:^|\\n)\\s*${qnum}\\s*\\n`),
    new RegExp(`第\\s*${qnum}\\s*題`),
  ]
  const cleanHint = cleanText(dbQHint).slice(0, 12)
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

async function renderPageToWebp(page, mupdf, outPath, scale = 3) {
  const px = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true)
  const png = Buffer.from(px.asPNG())
  await sharp(png).webp({ quality: 80 }).toFile(outPath)
}

async function pageToPng(page, mupdf, dpi = 144) {
  const m = mupdf.Matrix.scale(dpi/72, dpi/72)
  const px = page.toPixmap(m, mupdf.ColorSpace.DeviceRGB, false, true)
  return Buffer.from(px.asPNG())
}

// ─── Vertex Vision ───────────────────────────────────────────────────────
async function visionExtract(pngBuf, prompt) {
  if (noVision) return null
  const base64 = pngBuf.toString('base64')
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const token = await vertexAuth.getAccessToken()
      const body = {
        contents: [{ role: 'user', parts: [
          { inlineData: { data: base64, mimeType: 'image/png' } },
          { text: prompt },
        ]}],
        generationConfig: { temperature: 0.1, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
      }
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error?.message || JSON.stringify(data))
      const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
      const match = text.match(/[\[{][\s\S]*[\]}]/)
      if (!match) return null
      return JSON.parse(match[0])
    } catch (e) {
      if (attempt >= 2) { return { _error: e.message } }
      await sleep(2000 * (attempt + 1))
    }
  }
}

const PROMPT_FULL = `這是台灣國家考試試題掃描圖片。請從圖片中找出指定題號的單選題，完整抽出題目文字、四個選項 A/B/C/D。
題號：__QNUM__

只輸出純 JSON：{"number": __QNUM__, "question": "...", "options": {"A": "...", "B": "...", "C": "...", "D": "..."}}
若該選項是圖表/圖片無法辨識為文字，對應選項填入 "[圖]"。
若題目跨頁、本頁看不到完整題目，仍請依本頁可見內容輸出（不要拒答）。`

// ─── Patcher functions ─────────────────────────────────────────────────
function patchOptionsAndQuestion(q, ocr) {
  let changed = false
  if (q.options && ocr.options) {
    for (const k of ['A','B','C','D']) {
      const cur = q.options[k]
      const nv = ocr.options[k]
      const isEmpty = !cur || cur === '' || cur === k
      if (isEmpty && nv && nv !== '[圖]') {
        q.options[k] = nv
        changed = true
      }
    }
  }
  if (ocr.question && ocr.question.length > (q.question||'').length + 5) {
    q.question = ocr.question
    changed = true
  }
  if (changed) {
    const stillEmpty = ['A','B','C','D'].filter(k => {
      const v = q.options?.[k]
      return v == null || v === '' || v === '[圖]'
    }).length
    if (stillEmpty === 0 && (q.question||'').length >= 10) {
      delete q.incomplete
      delete q.gap_reason
    }
  }
  return changed
}

// ─── Load all JSON files once ──────────────────────────────────────────
function loadJsons() {
  const cache = {}  // examId -> { fp, raw, arr, dirty }
  for (const [exam, file] of Object.entries(EXAM_FILES)) {
    if (SKIP_FILES.has(file)) continue
    const fp = path.join(BACKEND, file)
    if (!fs.existsSync(fp)) continue
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'))
    const arr = Array.isArray(raw) ? raw : (raw.questions || raw.data)
    if (!arr) continue
    cache[exam] = { fp, raw, arr, dirty: false }
  }
  return cache
}

function saveJson(entry) {
  if (!entry.dirty) return
  const toSave = Array.isArray(entry.raw) ? entry.arr : entry.raw
  fs.writeFileSync(entry.fp, JSON.stringify(toSave, null, 2))
  entry.dirty = false
}

function findQuestionInArr(arr, flagged) {
  return arr.find(q => {
    if (flagged.id != null && q.id != null && q.id === flagged.id) return true
    return q.exam_code === flagged.exam_code && q.subject === flagged.subject && q.number === flagged.number
  })
}

// ─── Main loop ──────────────────────────────────────────────────────────
async function main() {
  const scanPath = path.join(BACKEND, '_tmp', 'patrol-scan.json')
  const scan = JSON.parse(fs.readFileSync(scanPath, 'utf8'))
  let flagged = scan.flagged

  if (onlyCat) {
    flagged = flagged.filter(f => f.tags.some(t => t.split(':')[0] === onlyCat))
  }
  if (onlyExam) {
    const exams = onlyExam.split(',')
    flagged = flagged.filter(f => exams.includes(f.examId))
  }
  if (limit > 0) flagged = flagged.slice(0, limit)

  console.log(`[patrol-fix] target=${flagged.length} dry=${dryRun} cat=${onlyCat||'all'} exam=${onlyExam||'all'}`)

  if (!fs.existsSync(IMG_OUT)) fs.mkdirSync(IMG_OUT, { recursive: true })

  const jsonCache = loadJsons()
  const log = []
  const stats = { tried: 0, fixed: 0, failed: 0, no_pdf: 0, no_page: 0, no_ocr: 0, vision_err: 0, by_cat: {}, by_exam: {} }
  const missingPdfs = new Set()
  const unfixable = []

  let saveCounter = 0
  for (let i = 0; i < flagged.length; i++) {
    const f = flagged[i]
    const entry = jsonCache[f.examId]
    if (!entry) { stats.failed++; unfixable.push({ ...f, why: 'no exam entry' }); continue }
    const q = findQuestionInArr(entry.arr, f)
    if (!q) { stats.failed++; unfixable.push({ ...f, why: 'question not found in JSON' }); continue }

    stats.tried++
    const cat = f.tags[0].split(':')[0]
    stats.by_cat[cat] = (stats.by_cat[cat] || 0) + 1
    stats.by_exam[f.examId] = stats.by_exam[f.examId] || { tried: 0, fixed: 0 }
    stats.by_exam[f.examId].tried++

    if (dryRun) {
      console.log(`  [${i+1}/${flagged.length}] ${f.examId} ${f.exam_code} Q${f.number} (${cat})`)
      continue
    }

    try {
      // ── locate PDF ──
      const candidates = findCandidatePdfs(f.examId, f.exam_code)
      if (candidates.length === 0) {
        missingPdfs.add(`${f.examId}/${f.exam_code}`)
        stats.no_pdf++
        unfixable.push({ ...f, why: 'no cached PDF' })
        console.log(`  ✗ ${f.examId} ${f.roc_year}${f.session||''} ${f.subject||''} 第${f.number}題 — no cached PDF`)
        continue
      }
      const dbQHint = (q.question || f.question_preview || '').replace(/^\d+[.、．\s]*/,'').trim().slice(0, 30)
      let info = null
      let sourceFile = null
      let sourceDir = null
      for (const { dir, file: pdf } of candidates) {
        try {
          info = await findPageWithQuestion(path.join(dir, pdf), f.number, dbQHint)
          if (info) { sourceFile = pdf; sourceDir = dir; break }
        } catch (e) { /* keep trying */ }
      }
      if (!info) {
        stats.no_page++
        unfixable.push({ ...f, why: 'page not found in any PDF' })
        console.log(`  ✗ ${f.examId} ${f.roc_year}${f.session||''} ${f.subject||''} 第${f.number}題 — no page match`)
        continue
      }

      let fixed = false
      let method = ''

      if (cat === 'missing_image') {
        // Render full page as image; do NOT touch options
        const outName = `${f.examId}_${f.exam_code}_q${f.number}_patrol.webp`
        const outPath = path.join(IMG_OUT, outName)
        await renderPageToWebp(info.page, info.mupdf, outPath, 3)
        // Maybe options span next page; render next as well if D not present
        const curText = (await loadPdfPages(path.join(sourceDir, sourceFile))).pages[info.idx].text
        if (!/\(D\)|（D）|D[.、．]/.test(curText) && info.idx + 1 < info.totalPages) {
          const nextPage = info.doc.loadPage(info.idx + 1)
          const nextOut = path.join(IMG_OUT, `${f.examId}_${f.exam_code}_q${f.number}_patrol_next.webp`)
          await renderPageToWebp(nextPage, info.mupdf, nextOut, 3)
        }
        q.image_url = '/question-images/' + outName
        // Don't change incomplete or options here — text is already present
        method = 'rendered page → image_url'
        fixed = true
      } else if (cat === 'empty_options' || cat === 'truly_broken' || cat === 'cross_contam') {
        if (noVision) {
          unfixable.push({ ...f, why: 'no-vision flag set' })
          console.log(`  ✗ skip vision (--no-vision): ${f.examId} Q${f.number}`)
          continue
        }
        const png = await pageToPng(info.page, info.mupdf)
        const prompt = PROMPT_FULL.replace(/__QNUM__/g, f.number)
        const ocr = await visionExtract(png, prompt)
        if (!ocr || ocr._error) {
          stats.vision_err += ocr?._error ? 1 : 0
          stats.no_ocr += !ocr ? 1 : 0
          unfixable.push({ ...f, why: ocr?._error ? `vision: ${ocr._error}` : 'no OCR result' })
          console.log(`  ✗ ${f.examId} Q${f.number} — vision failed`)
          continue
        }
        // For cross_contam: ALWAYS replace question text (existing is corrupted)
        if (cat === 'cross_contam' && ocr.question && ocr.question.length >= 10) {
          q.question = ocr.question
          // Also replace options since they may also be contaminated
          if (ocr.options) {
            for (const k of ['A','B','C','D']) {
              const nv = ocr.options[k]
              if (nv && nv !== '[圖]') q.options[k] = nv
            }
          }
          delete q.gap_reason
          method = 'vision (cross-contam full replace)'
          fixed = true
        } else if (q.question && q.question.length > 30 && ocr.question) {
          // Sanity check for non-contam: OCR question must roughly match
          const a = cleanText(q.question).slice(0, 8)
          const b = cleanText(ocr.question)
          if (a && !b.includes(a.slice(0, 5))) {
            // OCR may have parsed wrong question — only patch options, not question text
            const ocrSafe = { options: ocr.options }
            if (patchOptionsAndQuestion(q, ocrSafe)) {
              method = 'vision (options only, mismatch on text)'
              fixed = true
            }
          } else {
            if (patchOptionsAndQuestion(q, ocr)) {
              method = 'vision OCR full'
              fixed = true
            }
          }
        } else {
          if (patchOptionsAndQuestion(q, ocr)) {
            method = 'vision OCR full'
            fixed = true
          }
        }
        if (!fixed) {
          unfixable.push({ ...f, why: 'OCR returned, but no fields changed' })
          console.log(`  ~ ${f.examId} Q${f.number} — OCR no-change`)
          continue
        }
      }

      if (fixed) {
        stats.fixed++
        stats.by_exam[f.examId].fixed++
        entry.dirty = true
        saveCounter++
        const line = `✓ ${f.examId} ${f.roc_year||''}${f.session||''} ${f.subject||''} 第${f.number}題 — ${method}`
        log.push(line)
        console.log(`  ${line}`)
        if (saveCounter % 10 === 0) {
          for (const e of Object.values(jsonCache)) saveJson(e)
        }
      }
    } catch (err) {
      stats.failed++
      unfixable.push({ ...f, why: 'exception: ' + err.message })
      console.log(`  ✗ ${f.examId} Q${f.number}: ${err.message}`)
    }
  }

  // Final save
  for (const e of Object.values(jsonCache)) saveJson(e)

  // Write logs
  fs.writeFileSync(path.join(BACKEND, '_tmp', 'patrol-fix-log.json'),
    JSON.stringify({ stats, log, unfixable, missingPdfs: Array.from(missingPdfs) }, null, 2))
  console.log('\n=== STATS ===')
  console.log(JSON.stringify(stats, null, 2))
  console.log(`Missing PDF combos: ${missingPdfs.size}`)
  console.log(`Unfixable: ${unfixable.length}`)
}

main().catch(e => { console.error(e); process.exit(1) })
