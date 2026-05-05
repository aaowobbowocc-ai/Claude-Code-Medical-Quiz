#!/usr/bin/env node
/**
 * Batch Vision OCR fixer for remaining incomplete questions across exams.
 *
 * Handles these gap types per question:
 *   empty_options  / options have empty values         → ask Vision to fill missing letters
 *   short_question / parser_circled_number_collision   → ask Vision for full question text
 *   missing_image_dep where PDF wasn't found by batch  → skip (no PDF)
 *
 * For each target, finds the page containing the question via text search,
 * sends ONE page to Vertex AI Gemini, parses JSON response, patches JSON.
 *
 * Run: node scripts/fix-incomplete-batch-vision.js [--exam=medlab,dental1,...] [--limit=N]
 */

require('dotenv/config')
const fs    = require('fs')
const path  = require('path')
const { GoogleAuth } = require('google-auth-library')

const BACKEND   = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')

const VERTEX_PROJECT = 'gen-lang-client-0502672630'
const VERTEX_REGION  = 'us-central1'
const VERTEX_MODEL   = 'gemini-2.5-pro'
const vertexAuth     = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const EXAM_FILES = {
  medlab:    'questions-medlab.json',
  dental1:   'questions-dental1.json',
  dental2:   'questions-dental2.json',
  nursing:   'questions-nursing.json',
  pharma1:   'questions-pharma1.json',
  pharma2:   'questions-pharma2.json',
  vet:       'questions-vet.json',
  customs:   'questions-customs.json',
  doctor1:   'questions.json',
  doctor2:   'questions-doctor2.json',
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ─── PDF discovery + page rendering ────────────────────────────────────────
let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }

const pdfCache = {}
async function loadPdf(pdfPath) {
  if (pdfCache[pdfPath]) return pdfCache[pdfPath]
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n = doc.countPages()
  const pages = []
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i)
    const text = page.toStructuredText('preserve-whitespace').asText()
    pages.push({ page, text, idx: i })
  }
  const result = { doc, pages, mupdf }
  pdfCache[pdfPath] = result
  return result
}

async function discoverPdf(exam, exam_code, subject, allArr) {
  const prefix = `${exam}_${exam_code}_`
  const candidates = fs.readdirSync(PDF_CACHE).filter(f => f.startsWith(prefix) && f.endsWith('.pdf'))
  // Subject literal match
  for (const f of candidates) {
    const { pages, mupdf } = await loadPdf(path.join(PDF_CACHE, f))
    if (pages[0].text.includes(subject)) {
      return { file: f, pages, mupdf }
    }
  }
  // Content fingerprint match using a complete sibling
  const sameGroup = allArr.filter(q =>
    q.exam_code === exam_code && q.subject === subject &&
    q.question && q.question.length >= 30 && !q.incomplete
  )
  if (!sameGroup.length) return null
  // Try multiple probe questions; for each, prefer long Chinese-only runs but
  // fall back to mixed-content runs (Chinese + brackets are common in the data).
  function pickSnippet(text) {
    const cn = (text.match(/[一-鿿]+/g) || []).find(s => s.length >= 8)
    if (cn) return cn.substring(0, Math.min(cn.length, 12))
    const mixed = (text.match(/[一-鿿\w（）().,，]+/g) || []).find(s => s.length >= 10)
    return mixed ? mixed.substring(0, 10) : null
  }
  const probes = [
    sameGroup[Math.floor(sameGroup.length / 2)],
    sameGroup[0],
    sameGroup[sameGroup.length - 1],
  ].filter(Boolean)
  let snippet = null
  for (const p of probes) {
    snippet = pickSnippet(p.question)
    if (snippet) break
  }
  if (!snippet) return null
  for (const f of candidates) {
    const { pages, mupdf } = await loadPdf(path.join(PDF_CACHE, f))
    if (pages.some(p => p.text.includes(snippet))) {
      return { file: f, pages, mupdf }
    }
  }
  return null
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

async function pageToPng(page, mupdf, dpi = 144) {
  const matrix = mupdf.Matrix.scale(dpi / 72, dpi / 72)
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true)
  return Buffer.from(pixmap.asPNG())
}

// ─── Vertex Vision call ────────────────────────────────────────────────────
async function visionExtract(pngBuf, prompt) {
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
        generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
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
      if (attempt >= 2) { console.log(`    Vision failed: ${e.message}`); return null }
      await sleep(2000 * (attempt + 1))
    }
  }
}

const PROMPT = `這是台灣國家考試試題掃描圖片。請從圖片中找出以下指定題號的單選題，完整抽出題目文字、四個選項 A/B/C/D。
題號：__QNUM__

只輸出純 JSON：{"number": __QNUM__, "question": "...", "options": {"A": "...", "B": "...", "C": "...", "D": "..."}}
若該選項是圖表/圖片無法辨識為文字，對應選項填入 "[圖]"。
若題目跨頁、本頁看不到完整題目，仍請依本頁可見內容輸出（不要拒答）。`

// ─── Patcher ───────────────────────────────────────────────────────────────
function patchQuestion(q, ocr) {
  let changed = false
  // Empty options: fill any missing/empty
  if (q.options) {
    for (const k of ['A', 'B', 'C', 'D']) {
      const cur = q.options[k]
      const nv = ocr.options?.[k]
      if ((!cur || cur === k) && nv && nv !== '[圖]') {
        q.options[k] = nv
        changed = true
      }
    }
  }
  // Short question / parser collision: extend question text
  if (ocr.question && ocr.question.length > (q.question || '').length) {
    q.question = ocr.question
    changed = true
  }
  if (changed) {
    // Decide if fully fixed: no empty options + question reasonable
    const stillEmpty = Object.values(q.options || {}).filter(v => !v || v === '[圖]').length
    if (stillEmpty === 0 && (q.question || '').length >= 10) {
      delete q.incomplete
      delete q.gap_reason
    }
  }
  return changed
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function processExam(examId, limit) {
  const file = EXAM_FILES[examId]
  if (!file) return 0
  const filePath = path.join(BACKEND, file)
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const arr = raw.questions || raw

  const candidates = arr.filter(q => q.incomplete)
  if (candidates.length === 0) return 0

  const targets = limit ? candidates.slice(0, limit) : candidates
  console.log(`\n=== ${examId} (${targets.length}/${candidates.length} targets) ===`)

  let patched = 0
  for (let i = 0; i < targets.length; i++) {
    const q = targets[i]
    process.stdout.write(`  [${i+1}/${targets.length}] Q${q.number} ${q.exam_code} ${q.subject}... `)

    const found = await discoverPdf(examId, q.exam_code, q.subject, arr)
    if (!found) { console.log('no PDF'); continue }

    const pageIdx = findQuestionPage(found.pages, q.number)
    if (pageIdx < 0) { console.log('page not found'); continue }

    const png = await pageToPng(found.pages[pageIdx].page, found.mupdf)
    const prompt = PROMPT.replace(/__QNUM__/g, q.number)
    const ocr = await visionExtract(png, prompt)
    if (!ocr) { console.log('no OCR result'); continue }

    if (patchQuestion(q, ocr)) {
      patched++
      console.log('✓ patched' + (q.incomplete ? ' (still incomplete)' : ''))
    } else {
      console.log('no change')
    }

    // Save every 5 patches in case of interruption
    if (patched > 0 && patched % 5 === 0) {
      const toSave = raw.questions ? raw : arr
      fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2))
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
  const argExam  = process.argv.find(a => a.startsWith('--exam='))?.slice(7)
  const argLimit = process.argv.find(a => a.startsWith('--limit='))?.slice(8)
  const limit = argLimit ? parseInt(argLimit) : 0
  const exams = argExam ? argExam.split(',') : ['medlab', 'dental1', 'dental2', 'nursing', 'pharma1', 'vet', 'customs']
  let total = 0
  for (const examId of exams) {
    total += await processExam(examId, limit)
  }
  console.log(`\n總計: ${total} questions patched`)
}

main().catch(e => { console.error(e); process.exit(1) })
