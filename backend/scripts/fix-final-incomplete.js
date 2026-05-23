#!/usr/bin/env node
/**
 * 最後一搏：對 24 題 incomplete 做更寬鬆的 page 搜尋。
 * 1. 拿掉嚴格的 cleanHint 比對（PDF 解析可能跨欄錯位導致 hint 找不到，但 page 號是對的）
 * 2. 用 Vision 直接 OCR 該頁，靠 question text 比對
 * 3. 處理三種：4 圖選項題 / 1 圖+文字選項題 / 純文字題
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
const SCALE = 4
const VERTEX_PROJECT = 'gen-lang-client-0502672630'
const VERTEX_REGION = 'us-central1'
// MODEL: gemini-2.5-flash (changed 2026-05-23 from gemini-2.5-pro)
//   OCR / Vision 任務不需要 Pro 推理；Flash 同準確度但便宜 ~17-33 倍。
//   5/22 batch 跑 Pro thinking 一次燒 $200+，Flash 同 batch 約 $5-10。
//   若特殊題目 Flash 結果不佳，再針對該批改回 'gemini-2.5-pro'。
const VERTEX_MODEL = 'gemini-2.5-flash'
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')
const cleanText = s => (s || '').normalize('NFKC').replace(/[\s,，。、．.;；:：?？!！()（）「」『』《》<>《》【】\[\]]/g, '')

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }

const EXAM_FILES = {
  pharma2: 'questions-pharma2.json',
  nursing: 'questions-nursing.json',
  ot: 'questions-ot.json',
  radiology: 'questions-radiology.json',
  tcm1: 'questions-tcm1.json',
  tcm2: 'questions-tcm2.json',
  vet: 'questions-vet.json',
}

function findCandidatePdfs(exam, exam_code) {
  return fs.readdirSync(PDF_CACHE).filter(f =>
    f.endsWith('.pdf') &&
    !/^(TM|TS|M|S|A|TA)_/.test(f) &&
    (f.startsWith(`${exam}_${exam_code}_`) || new RegExp(`(?:^|_)Q_${exam_code}_c\\d+_s`).test(f))
  )
}

// More relaxed: try to find page by qnum + ANY 2-char hint from question
async function findPageRelaxed(pdfPath, qnum, qStem) {
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n = doc.countPages()
  const patterns = [
    new RegExp(`(?:^|\\n)\\s*${qnum}\\s*[.、．]`),
    new RegExp(`(?:^|\\n)\\s*${qnum}\\s*\\n`),
    new RegExp(`第\\s*${qnum}\\s*題`),
  ]
  // Try multiple chunks of 4 chars from question stem
  const cleanQ = cleanText(qStem)
  const hints = []
  for (let i = 0; i + 4 <= cleanQ.length && hints.length < 5; i += 4) {
    hints.push(cleanQ.slice(i, i + 4))
  }
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i)
    const text = stripPUA(page.toStructuredText('preserve-whitespace').asText())
    const cleaned = cleanText(text)
    let qnumMatched = patterns.some(re => re.test(text))
    if (!qnumMatched) continue
    // Check if any hint matches
    const hintHit = hints.some(h => h.length >= 4 && cleaned.includes(h))
    if (hintHit) return { doc, mupdf, idx: i }
  }
  return { doc, mupdf, idx: -1 }  // fallback: no good page found
}

async function pageToPng(doc, mupdf, idx) {
  const page = doc.loadPage(idx)
  const px = page.toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceRGB, false, true)
  return Buffer.from(px.asPNG())
}

async function visionExtract(pngBuf, qnum, qStem) {
  const tk = await auth.getAccessToken()
  const tokenStr = (typeof tk === 'string') ? tk : tk.token
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`
  const prompt = `這是試題掃描頁。請找出第 ${qnum} 題（題幹開頭：「${qStem.slice(0, 40)}」）並判斷此題格式 + 提取資料。

**只回 JSON**：
{
  "found": true/false,
  "type": "text_options" | "4_image_options" | "single_image_text_options",
  "options": {"A":"...", "B":"...", "C":"...", "D":"..."} (text_options 或 single_image 才填),
  "boxes": {"A":[ymin,xmin,ymax,xmax], ...} (4_image_options 才填，bbox 標準化 0-1000，緊貼圖片不含標籤)
}

如沒找到該題回 {"found": false}`

  const parts = [
    { inlineData: { data: pngBuf.toString('base64'), mimeType: 'image/png' } },
    { text: prompt }
  ]
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenStr}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.1, maxOutputTokens: 8192 } }),
  })
  const data = await resp.json()
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
  const m = text.match(/\{[\s\S]*\}/)
  if (m) { try { return JSON.parse(m[0]) } catch {} }
  return null
}

async function cropFromPng(pngBuf, box, outPath) {
  const meta = await sharp(pngBuf).metadata()
  const W = meta.width, H = meta.height
  const [ymin, xmin, ymax, xmax] = box
  const left = Math.max(0, Math.round(xmin / 1000 * W))
  const top = Math.max(0, Math.round(ymin / 1000 * H))
  const width = Math.min(W, Math.round(xmax / 1000 * W)) - left
  const height = Math.min(H, Math.round(ymax / 1000 * H)) - top
  if (width < 20 || height < 20) throw new Error(`bbox too small`)
  await sharp(pngBuf).extract({ left, top, width, height }).webp({ quality: 85 }).toFile(outPath)
}

async function main() {
  const stats = { fixed: 0, failed: 0 }
  for (const [exam, file] of Object.entries(EXAM_FILES)) {
    const fp = path.join(BACKEND, file)
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
    const arr = data.questions || data
    const targets = arr.filter(q => q.incomplete === true)
    if (!targets.length) continue
    console.log(`\n[${exam}] ${targets.length} target(s)`)

    for (const q of targets) {
      const candidates = findCandidatePdfs(exam, q.exam_code)
      let info = null, sourcePdf = null
      for (const f of candidates) {
        try {
          info = await findPageRelaxed(path.join(PDF_CACHE, f), q.number, q.question)
          if (info && info.idx >= 0) { sourcePdf = f; break }
        } catch {}
      }
      if (!info || info.idx < 0) {
        console.log(`  ✗ ${q.id} (${q.exam_code} Q${q.number}): no PDF page`)
        stats.failed++
        continue
      }
      try {
        const pngBuf = await pageToPng(info.doc, info.mupdf, info.idx)
        const v = await visionExtract(pngBuf, q.number, q.question)
        if (!v || !v.found) {
          console.log(`  ✗ ${q.id} (${q.exam_code} Q${q.number}): vision not found`)
          stats.failed++
          continue
        }
        if (v.type === 'text_options' && v.options &&
            ['A','B','C','D'].every(o => v.options[o] && v.options[o].length > 0)) {
          q.options = { ...v.options }
          delete q.image_url
          delete q.option_images
          delete q.incomplete
          delete q.gap_reason
          console.log(`  ✓ ${q.id} (${q.exam_code} Q${q.number}): text options`)
          stats.fixed++
        } else if (v.type === 'single_image_text_options' && v.options) {
          // Save full page as image_url + text options
          const outName = `${exam}_${q.exam_code}_q${q.number}_full.webp`
          await sharp(pngBuf).webp({ quality: 80 }).toFile(path.join(IMG_OUT, outName))
          q.image_url = '/question-images/' + outName
          q.options = { ...v.options }
          delete q.option_images
          delete q.incomplete
          delete q.gap_reason
          console.log(`  ✓ ${q.id} (${q.exam_code} Q${q.number}): stem image + text options`)
          stats.fixed++
        } else if (v.type === '4_image_options' && v.boxes &&
                   ['A','B','C','D'].every(o => Array.isArray(v.boxes[o]) && v.boxes[o].length === 4)) {
          const option_images = {}
          for (const letter of ['A','B','C','D']) {
            const outName = `${exam}_${q.exam_code}_q${q.number}_opt_${letter}.webp`
            await cropFromPng(pngBuf, v.boxes[letter], path.join(IMG_OUT, outName))
            option_images[letter] = '/question-images/' + outName
          }
          q.option_images = option_images
          q.options = { A: '(圖)', B: '(圖)', C: '(圖)', D: '(圖)' }
          delete q.image_url
          delete q.incomplete
          delete q.gap_reason
          console.log(`  ✓ ${q.id} (${q.exam_code} Q${q.number}): cropped 4 images`)
          stats.fixed++
        } else {
          console.log(`  ✗ ${q.id} (${q.exam_code} Q${q.number}): unhandled type ${v.type}`)
          stats.failed++
        }
      } catch (e) {
        console.log(`  ✗ ${q.id} (${q.exam_code} Q${q.number}): ${e.message}`)
        stats.failed++
      }
    }
    fs.writeFileSync(fp, JSON.stringify(data, null, 2))
  }
  console.log(`\n=== ${stats.fixed} fixed, ${stats.failed} failed ===`)
}

main().catch(e => { console.error(e); process.exit(1) })
