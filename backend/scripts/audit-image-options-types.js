#!/usr/bin/env node
/**
 * 對 70 個 incomplete='image_options' 題目用 Vertex Vision 重新分類：
 *   A. 4 個獨立圖片選項（TCM 藥材、結構式）→ AI 裁圖
 *   B. 1 張題幹圖 + 文字選項 → 還原文字選項，圖留 image_url
 *   C. 跨頁題 → 渲染兩頁
 *   N. 純文字題（誤判）→ 不需要圖
 *
 * 把分類結果寫到 _tmp/image-options-audit.json 供後續腳本用。
 *
 * Usage: node scripts/audit-image-options-types.js [--exam=tcm1]
 */
require('dotenv/config')
const fs = require('fs')
const path = require('path')
const { GoogleAuth } = require('google-auth-library')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')
const OUT_FILE = path.join(BACKEND, '_tmp', 'image-options-audit.json')
const SCALE = 3
const VERTEX_PROJECT = 'gen-lang-client-0502672630'
const VERTEX_REGION = 'us-central1'
const VERTEX_MODEL = 'gemini-2.5-pro'
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const args = process.argv.slice(2)
const examFilter = args.find(a => a.startsWith('--exam='))?.split('=')[1] || 'all'
const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1]) || Infinity
const concurrency = 2

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
  const result = { doc, pages, mupdf, totalPages: n }
  pdfPageCache[pdfPath] = result
  return result
}

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

async function findPageWithQuestion(pdfPath, qnum, dbQHint) {
  const { pages, mupdf, doc, totalPages } = await loadPdfPages(pdfPath)
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
        return { page: p.page, idx: p.idx, mupdf, doc, totalPages }
      }
    }
  }
  return null
}

async function pageToPng(page, mupdf, scale = SCALE) {
  const px = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true)
  return Buffer.from(px.asPNG())
}

async function classifyQuestion(pngBuf1, pngBuf2, qnum, qStem) {
  const tk = await auth.getAccessToken()
  const tokenStr = (typeof tk === 'string') ? tk : tk.token
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`

  const prompt = `這是試題掃描頁。第 ${qnum} 題題幹：「${qStem.slice(0, 80)}」

請分類此題的選項格式，返回 JSON：

{
  "type": "4_image_options" | "single_image_text_options" | "no_image_needed" | "cross_page",
  "options_text": {"A": "...", "B": "...", "C": "...", "D": "..."} (僅當有文字選項時),
  "boxes": {"A": [ymin,xmin,ymax,xmax], "B": [...], "C": [...], "D": [...]} (僅當 4_image_options，bbox 標準化 0-1000),
  "stem_image_box": [ymin,xmin,ymax,xmax] (僅當 single_image_text_options，題幹附圖位置),
  "note": "簡短說明"
}

分類規則：
- 4_image_options: 4 個 ABCD 選項本身是 4 張獨立圖片（如 4 張藥材照、4 個結構式）
- single_image_text_options: 題目有 1 張參考圖（X 光、ECG、結構圖），但 ABCD 選項是文字
- no_image_needed: 題目跟選項都是文字，不需要任何圖（誤判）
- cross_page: 題幹圖或選項在「下一頁」（請看第 2 張圖確認）

**只回 JSON，不要解釋**`

  const parts = [
    { inlineData: { data: pngBuf1.toString('base64'), mimeType: 'image/png' } }
  ]
  if (pngBuf2) parts.push({ inlineData: { data: pngBuf2.toString('base64'), mimeType: 'image/png' } })
  parts.push({ text: prompt })

  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 180000)
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenStr}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.1, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } } }),
        signal: ctrl.signal,
      })
      if (resp.status === 429) { await new Promise(r => setTimeout(r, 5000 * (attempt + 1))); continue }
      if (!resp.ok) { if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue } throw new Error('HTTP ' + resp.status) }
      const data = await resp.json()
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
      const m = text.match(/\{[\s\S]*\}/)
      if (m) { try { return JSON.parse(m[0]) } catch {} }
      return null
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 3000))
      else throw e
    }
  }
  return null
}

async function processQuestion(q, exam) {
  const dbQHint = (q.question || '').replace(/^\d+[.、．\s]*/, '').trim().slice(0, 30)
  const candidates = findCandidatePdfs(exam, q.exam_code)
  let info = null, sourcePdf = null
  for (const f of candidates) {
    try {
      info = await findPageWithQuestion(path.join(PDF_CACHE, f), q.number, dbQHint)
      if (info) { sourcePdf = f; break }
    } catch {}
  }
  if (!info) throw new Error('no PDF page')

  const pngBuf1 = await pageToPng(info.page, info.mupdf, SCALE)
  let pngBuf2 = null
  if (info.idx + 1 < info.totalPages) {
    const next = info.doc.loadPage(info.idx + 1)
    pngBuf2 = await pageToPng(next, info.mupdf, SCALE)
  }
  const result = await classifyQuestion(pngBuf1, pngBuf2, q.number, q.question)
  return { result, sourcePdf, hasNextPage: !!pngBuf2 }
}

async function main() {
  const exams = examFilter === 'all' ? Object.keys(EXAM_FILES) : examFilter.split(',')
  const allTasks = []
  for (const exam of exams) {
    const file = EXAM_FILES[exam]
    if (!file) continue
    const fp = path.join(BACKEND, file)
    if (!fs.existsSync(fp)) continue
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
    const arr = data.questions || data
    for (const q of arr.filter(q => q.incomplete === 'image_options' && q.image_url && !q.option_images)) {
      allTasks.push({ exam, q })
    }
  }
  const todo = allTasks.slice(0, limit)
  console.log(`[audit] ${todo.length} target(s) across exams`)

  const audit = {}
  let done = 0
  const queue = [...todo]
  async function worker() {
    while (queue.length) {
      const { exam, q } = queue.shift()
      const key = `${exam}:${q.id}`
      try {
        const { result, sourcePdf } = await processQuestion(q, exam)
        if (result) {
          audit[key] = { exam, id: q.id, exam_code: q.exam_code, number: q.number, sourcePdf, ...result }
          console.log(`  ✓ ${key} type=${result.type}${result.note ? ' (' + result.note + ')' : ''}`)
        } else {
          audit[key] = { exam, id: q.id, error: 'classify returned null' }
          console.log(`  ✗ ${key}: classify null`)
        }
      } catch (e) {
        audit[key] = { exam, id: q.id, error: e.message }
        console.log(`  ✗ ${key}: ${e.message}`)
      }
      done++
      if (done % 5 === 0) {
        fs.writeFileSync(OUT_FILE, JSON.stringify(audit, null, 2))
        console.log(`  [progress] ${done}/${todo.length}`)
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  fs.writeFileSync(OUT_FILE, JSON.stringify(audit, null, 2))

  // Summary
  const types = {}
  for (const k of Object.keys(audit)) {
    const t = audit[k].type || audit[k].error || 'unknown'
    types[t] = (types[t] || 0) + 1
  }
  console.log(`\n=== TYPE SUMMARY ===`)
  for (const [t, n] of Object.entries(types).sort((a,b) => b[1]-a[1])) console.log(`  ${t}: ${n}`)
  console.log(`\nWritten ${OUT_FILE}`)
}

main().catch(e => { console.error(e); process.exit(1) })
