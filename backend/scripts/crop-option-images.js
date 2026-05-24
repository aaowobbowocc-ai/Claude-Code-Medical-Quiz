#!/usr/bin/env node
/**
 * 對 incomplete='image_options' 題目，用 Vertex Gemini 偵測 4 個 ABCD 選項圖
 * 的 bounding box，再用 sharp 切出來作為 option_images.{A,B,C,D}。
 *
 * 修完題目就變成正常的 ABCD 圖選項題（4 個獨立小圖），incomplete 旗標移除。
 *
 * Usage:
 *   node scripts/crop-option-images.js --dry-run
 *   node scripts/crop-option-images.js --exam=tcm1 --limit=5
 *   node scripts/crop-option-images.js                  (run all 70)
 */
require('dotenv/config')
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')
const { GoogleAuth } = require('google-auth-library')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')
const IMG_OUT = path.join(BACKEND, '..', 'frontend', 'public', 'question-images')
const SCALE = 4  // 4x DPI for high-res cropping
const VERTEX_PROJECT = 'gen-lang-client-0502672630'
const VERTEX_REGION = 'us-central1'
// MODEL: gemini-2.5-flash (changed 2026-05-23 from gemini-2.5-pro)
//   OCR / Vision 任務不需要 Pro 推理；Flash 同準確度但便宜 ~17-33 倍。
//   5/22 batch 跑 Pro thinking 一次燒 $200+，Flash 同 batch 約 $5-10。
//   若特殊題目 Flash 結果不佳，再針對該批改回 'gemini-2.5-pro'。
const VERTEX_MODEL = 'gemini-2.5-flash'
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const examFilter = args.find(a => a.startsWith('--exam='))?.split('=')[1] || 'all'
const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1]) || Infinity
const concurrency = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1]) || 2

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
  const result = { doc, pages, mupdf }
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
        return { page: p.page, idx: p.idx, mupdf, doc }
      }
    }
  }
  return null
}

async function pageToPng(page, mupdf, scale = SCALE) {
  const px = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true)
  return Buffer.from(px.asPNG())
}

async function detectOptionBoxes(pngBuf, qnum) {
  const tk = await auth.getAccessToken()
  const tokenStr = (typeof tk === 'string') ? tk : tk.token
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`
  const prompt = `這是一張掃描的試題頁。請找出第 ${qnum} 題的 4 個選項圖（標記為 (A)、(B)、(C)、(D) 的圖片區塊）。

每個選項都是一張獨立的圖片（藥材照片、X光、結構式、心電圖等）。

請輸出每個選項圖的 bounding box，格式為 [ymin, xmin, ymax, xmax]，**標準化到 0-1000 範圍**（左上角 0,0；右下角 1000,1000）。

只回傳 JSON：
{"A": [ymin, xmin, ymax, xmax], "B": [...], "C": [...], "D": [...]}

注意：
- bounding box 只框「圖片本身」，不要包含 (A)/(B)/(C)/(D) 標籤文字
- 如果該題不是圖片選項題（4 個選項是文字而非圖），回 {"not_image_options": true}
- 如果只找到部分選項，回 {"partial": true, "found": ["A","C"]} 等`

  const parts = [
    { inlineData: { data: pngBuf.toString('base64'), mimeType: 'image/png' } },
    { text: prompt }
  ]
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 180000)
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenStr}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } }
        }),
        signal: ctrl.signal,
      })
      if (resp.status === 429) { await new Promise(r => setTimeout(r, 5000 * (attempt + 1))); continue }
      if (!resp.ok) {
        if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue }
        throw new Error('HTTP ' + resp.status)
      }
      const data = await resp.json()
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
      const m = text.match(/\{[\s\S]*\}/)
      if (m) {
        try { return JSON.parse(m[0]) }
        catch (e) {
          if (process.env.VERBOSE) console.log(`    JSON parse fail: ${e.message}\n    raw: ${m[0].slice(0,200)}`)
        }
      }
      if (process.env.VERBOSE) console.log(`    no JSON in response. text: ${text.slice(0,300)}`)
      return null
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 3000))
      else throw e
    }
  }
  return null
}

async function cropAndSave(pngBuf, box, outPath) {
  const meta = await sharp(pngBuf).metadata()
  const W = meta.width, H = meta.height
  // Gemini bbox format: [ymin, xmin, ymax, xmax] normalized 0-1000
  const [ymin, xmin, ymax, xmax] = box
  const left = Math.max(0, Math.round(xmin / 1000 * W))
  const top = Math.max(0, Math.round(ymin / 1000 * H))
  const right = Math.min(W, Math.round(xmax / 1000 * W))
  const bottom = Math.min(H, Math.round(ymax / 1000 * H))
  const width = right - left
  const height = bottom - top
  if (width < 20 || height < 20) throw new Error(`bbox too small: ${width}x${height}`)
  await sharp(pngBuf)
    .extract({ left, top, width, height })
    .webp({ quality: 85 })
    .toFile(outPath)
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

  const pngBuf = await pageToPng(info.page, info.mupdf, SCALE)
  const boxes = await detectOptionBoxes(pngBuf, q.number)
  if (!boxes) throw new Error('vision returned null')
  if (boxes.not_image_options) throw new Error('not image options')
  if (boxes.partial) throw new Error('partial: only ' + (boxes.found || []).join(','))

  const required = ['A', 'B', 'C', 'D']
  for (const o of required) {
    if (!Array.isArray(boxes[o]) || boxes[o].length !== 4) {
      throw new Error(`missing/invalid box for ${o}`)
    }
  }

  const option_images = {}
  for (const letter of required) {
    const outName = `${exam}_${q.exam_code}_q${q.number}_opt_${letter}.webp`
    const outPath = path.join(IMG_OUT, outName)
    await cropAndSave(pngBuf, boxes[letter], outPath)
    option_images[letter] = '/question-images/' + outName
  }

  return { option_images, sourcePdf }
}

async function processExam(exam) {
  const file = EXAM_FILES[exam]
  if (!file) return { fixed: 0, failed: 0 }
  const fp = path.join(BACKEND, file)
  if (!fs.existsSync(fp)) return { fixed: 0, failed: 0 }
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
  const arr = data.questions || data
  const targets = arr.filter(q => q.incomplete === 'image_options' && q.image_url && !q.option_images).slice(0, limit)
  if (!targets.length) return { fixed: 0, failed: 0 }

  console.log(`[${exam}] ${targets.length} target(s)`)
  if (dryRun) return { fixed: 0, failed: 0 }

  if (!fs.existsSync(IMG_OUT)) fs.mkdirSync(IMG_OUT, { recursive: true })

  let fixed = 0, failed = 0
  const queue = [...targets]
  async function worker() {
    while (queue.length) {
      const q = queue.shift()
      if (!q) break
      try {
        const { option_images, sourcePdf } = await processQuestion(q, exam)
        q.option_images = option_images
        q.options = q.options || {}
        for (const o of ['A','B','C','D']) q.options[o] = '(圖)'
        delete q.image_url
        delete q.incomplete
        delete q.gap_reason
        console.log(`  ✓ ${q.id} (${q.exam_code} Q${q.number}) ← ${sourcePdf}`)
        fixed++
      } catch (e) {
        console.log(`  ✗ ${q.id} (${q.exam_code} Q${q.number}): ${e.message}`)
        failed++
      }
      if ((fixed + failed) % 5 === 0) {
        fs.writeFileSync(fp, JSON.stringify(data, null, 2))
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  fs.writeFileSync(fp, JSON.stringify(data, null, 2))
  console.log(`[${exam}] ✓ ${fixed} fixed, ${failed} failed\n`)
  return { fixed, failed }
}

async function main() {
  const exams = examFilter === 'all' ? Object.keys(EXAM_FILES) : examFilter.split(',')
  console.log(`[crop-option-images] exams=${exams.join(',')} dry=${dryRun} limit=${limit} conc=${concurrency} scale=${SCALE}\n`)
  let totalFixed = 0, totalFailed = 0
  for (const e of exams) {
    const { fixed, failed } = await processExam(e)
    totalFixed += fixed
    totalFailed += failed
  }
  console.log(`=== TOTAL: ${totalFixed} fixed, ${totalFailed} failed ===`)
}

main().catch(e => { console.error(e); process.exit(1) })
