#!/usr/bin/env node
/**
 * One-shot OCR for specific reported questions.
 * Uses Vertex AI Gemini 2.5 Pro Vision (covered by GenAI App Builder credit).
 */

require('dotenv/config')
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')
const { GoogleAuth } = require('google-auth-library')

const BACKEND   = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')
const VERTEX_PROJECT = 'gen-lang-client-0502672630'
const VERTEX_REGION  = 'us-central1'
// MODEL: gemini-2.5-flash (changed 2026-05-23 from gemini-2.5-pro)
//   OCR / Vision 任務不需要 Pro 推理；Flash 同準確度但便宜 ~17-33 倍。
//   5/22 batch 跑 Pro thinking 一次燒 $200+，Flash 同 batch 約 $5-10。
//   若特殊題目 Flash 結果不佳，再針對該批改回 'gemini-2.5-pro'。
const VERTEX_MODEL   = 'gemini-2.5-flash'
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')

const TARGETS = [
  // medlab 100年第二次 病理學: code=100140, c=104, s=0107? Need to find s
  { exam: 'medlab', file: 'questions-medlab.json', exam_code: '100140', subject: '病理學', number: 79 },
  { exam: 'medlab', file: 'questions-medlab.json', exam_code: '100140', subject: '病理學', number: 61 },
  // medlab 112年第一次 臨床生理學: code=112020
  { exam: 'medlab', file: 'questions-medlab.json', exam_code: '112020', subject: '臨床生理學', number: 25 },
  { exam: 'medlab', file: 'questions-medlab.json', exam_code: '112020', subject: '臨床生理學', number: 36 },
  // medlab 100年第一次 病理學: code=100030
  { exam: 'medlab', file: 'questions-medlab.json', exam_code: '100030', subject: '病理學', number: 65 },
]

async function findPdf(target) {
  // Check existing cache for matching exam_code + subject content
  const prefix = `${target.exam}_${target.exam_code}_`
  const files = fs.readdirSync(PDF_CACHE).filter(f => f.startsWith(prefix) && f.endsWith('.pdf') && !f.startsWith('A_'))
  const mupdf = await import('mupdf')
  for (const f of files) {
    const buf = fs.readFileSync(path.join(PDF_CACHE, f))
    if (buf.length < 5000) continue
    const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
    const text = stripPUA(doc.loadPage(0).toStructuredText('preserve-whitespace').asText())
    if (text.includes(target.subject) || text.includes(target.subject.replace('學', ''))) {
      return { buf, doc, file: f }
    }
  }
  // Try with extended subject (e.g. 臨床生理學與病理學)
  for (const f of files) {
    const buf = fs.readFileSync(path.join(PDF_CACHE, f))
    if (buf.length < 5000) continue
    const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
    const text = stripPUA(doc.loadPage(0).toStructuredText('preserve-whitespace').asText())
    // 病理學 might be in 臨床生理學與病理學
    if (target.subject === '病理學' && /病理學/.test(text)) {
      return { buf, doc, file: f }
    }
    if (target.subject === '臨床生理學' && /臨床生理學/.test(text)) {
      return { buf, doc, file: f }
    }
  }
  return null
}

async function findQuestionPage(doc, qnum) {
  const n = doc.countPages()
  for (let i = 0; i < n; i++) {
    const t = stripPUA(doc.loadPage(i).toStructuredText('preserve-whitespace').asText())
    const re1 = new RegExp(`(?:^|\\n)\\s*${qnum}[.、．]`)
    const re2 = new RegExp(`(?:^|\\n)\\s*${qnum}\\s*\\n`)
    const re3 = new RegExp(`(?:^|\\n)\\s*${qnum}\\s{2,}[^\\d]`)
    if (re1.test(t) || re2.test(t) || re3.test(t)) return i
  }
  return -1
}

async function vision(pngB64, qnum) {
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`
  const token = await auth.getAccessToken()
  const prompt = `這是台灣國家考試試題掃描頁。請從圖片中抽出第 ${qnum} 題的完整題目和 4 個選項。
注意：
- 雙欄版型時，請依照「左上→左下→右上→右下」逐欄讀取，不要橫向讀
- 選項標籤可能是 A.B.C.D. 或無標籤直接列出
只輸出純 JSON：{"number":${qnum},"question":"...","options":{"A":"...","B":"...","C":"...","D":"..."}}`
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [
        { inlineData: { data: pngB64, mimeType: 'image/png' } },
        { text: prompt },
      ]}],
      generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
    }),
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error(JSON.stringify(data).slice(0, 200))
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
  const m = text.match(/[\[{][\s\S]*[\]}]/)
  return m ? JSON.parse(m[0]) : null
}

async function main() {
  for (const t of TARGETS) {
    console.log(`\n=== ${t.exam_code} ${t.subject} Q${t.number} ===`)
    const found = await findPdf(t)
    if (!found) { console.log('  no PDF found'); continue }
    console.log(`  PDF: ${found.file}`)
    const page = await findQuestionPage(found.doc, t.number)
    if (page < 0) { console.log('  page not found'); continue }
    console.log(`  page: ${page + 1}`)
    const mupdf = await import('mupdf')
    const pixmap = found.doc.loadPage(page).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true)
    const png = Buffer.from(pixmap.asPNG())
    let ocr
    try { ocr = await vision(png.toString('base64'), t.number) }
    catch (e) { console.log('  OCR error:', e.message.slice(0, 80)); continue }
    if (!ocr) { console.log('  OCR returned null'); continue }
    console.log('  OCR result:')
    console.log('    Q:', ocr.question?.slice(0, 80))
    console.log('    A:', ocr.options?.A?.slice(0, 60))
    console.log('    B:', ocr.options?.B?.slice(0, 60))
    console.log('    C:', ocr.options?.C?.slice(0, 60))
    console.log('    D:', ocr.options?.D?.slice(0, 60))

    // Apply to JSON
    const filePath = path.join(BACKEND, t.file)
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const arr = raw.questions || raw
    const idx = arr.findIndex(q => q.exam_code === t.exam_code && q.subject === t.subject && q.number === t.number)
    if (idx < 0) { console.log('  not in JSON'); continue }
    if (ocr.question && ocr.question.length >= 10) arr[idx].question = ocr.question
    if (ocr.options) {
      for (const k of ['A','B','C','D']) {
        if (ocr.options[k] && ocr.options[k].length > 0 && ocr.options[k] !== '[圖]') {
          arr[idx].options[k] = ocr.options[k]
        }
      }
    }
    delete arr[idx].incomplete
    delete arr[idx].gap_reason
    const toSave = raw.questions ? raw : arr
    fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2))
    console.log('  ✓ saved')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
