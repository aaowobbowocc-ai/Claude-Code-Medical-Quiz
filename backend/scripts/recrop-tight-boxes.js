#!/usr/bin/env node
/**
 * 重新偵測 bbox 並裁圖 — 用更嚴格的 prompt 解決原 boxes 太大的問題：
 *   1. 強調 bbox 必須緊貼「單一圖片內容」
 *   2. EXCLUDE (A)(B)(C)(D) 標籤文字
 *   3. EXCLUDE ruler、頁碼、下一題題幹
 *   4. 給範例什麼是 tight box
 *
 * 對所有已 type=4_image_options + 已有 option_images 的題目重做。
 * 直接覆蓋現有 option webps。
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
const AUDIT_FILE = path.join(BACKEND, '_tmp', 'image-options-audit.json')
const SCALE = 4  // 4x DPI for sharper detection
const VERTEX_PROJECT = 'gen-lang-client-0502672630'
const VERTEX_REGION = 'us-central1'
const VERTEX_MODEL = 'gemini-2.5-pro'
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
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
        return Buffer.from(px.asPNG())
      }
    }
  }
  return null
}

async function detectTightBoxes(pngBuf, qnum, qStem) {
  const tk = await auth.getAccessToken()
  const tokenStr = (typeof tk === 'string') ? tk : tk.token
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`

  const prompt = `這是試題掃描頁。第 ${qnum} 題：「${(qStem || '').slice(0, 60)}」

該題的 4 個選項是 4 張獨立圖片（標記 (A)(B)(C)(D)）。請輸出每張圖片**緊貼單一圖片本身**的 bounding box。

**嚴格規則**（違反任一條都是錯）：
1. bbox 只框該選項的「圖片內容」本身（藥材/結構式/X光等）
2. **絕對排除** (A)/(B)/(C)/(D) 標籤文字（標籤通常在圖片左上或圖片旁，不要包進來）
3. **絕對排除** 該題其他選項的圖片（即使靠很近）
4. **絕對排除** 尺、刻度、頁碼、下一題的題幹文字
5. 4 個 bbox 不能重疊
6. 每個 bbox 應該緊貼圖片邊緣，不要留太多空白

bbox 格式：[ymin, xmin, ymax, xmax]，**標準化到 0-1000**（左上 0,0；右下 1000,1000）。

只回 JSON：
{"A": [ymin, xmin, ymax, xmax], "B": [...], "C": [...], "D": [...]}

如果該題不是 4 圖選項題，回 {"not_4_image_options": true}`

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
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.05, maxOutputTokens: 8192 } }),
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

async function cropAndSave(pngBuf, box, outPath) {
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
  await sharp(pngBuf)
    .extract({ left, top, width, height })
    .webp({ quality: 85 })
    .toFile(outPath)
}

async function main() {
  const audit = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'))
  const targets = []
  for (const [key, info] of Object.entries(audit)) {
    if (info.type === '4_image_options') targets.push(info)
  }
  const todo = targets.slice(0, limit)
  console.log(`[recrop-tight] ${todo.length} target(s)`)
  if (dryRun) return

  if (!fs.existsSync(IMG_OUT)) fs.mkdirSync(IMG_OUT, { recursive: true })

  // Group by exam for JSON updates
  const examData = {}
  for (const exam of new Set(todo.map(t => t.exam))) {
    const fp = path.join(BACKEND, EXAM_FILES[exam])
    examData[exam] = { fp, data: JSON.parse(fs.readFileSync(fp, 'utf8')) }
  }

  let fixed = 0, failed = 0
  const queue = [...todo]
  async function worker() {
    while (queue.length) {
      const info = queue.shift()
      if (!info) break
      const { exam, id, exam_code, number } = info
      try {
        const data = examData[exam].data
        const arr = data.questions || data
        const q = arr.find(x => x.id === id)
        if (!q) throw new Error('q not found in JSON')

        // Re-render PDF page at high DPI
        const dbQHint = (q.question || '').replace(/^\d+[.、．\s]*/, '').trim().slice(0, 30)
        let pngBuf = null
        for (const f of findCandidatePdfs(exam, exam_code)) {
          try {
            pngBuf = await renderPagePng(path.join(PDF_CACHE, f), number, dbQHint)
            if (pngBuf) break
          } catch {}
        }
        if (!pngBuf) throw new Error('PDF page not found')

        // Re-detect tight boxes
        const boxes = await detectTightBoxes(pngBuf, number, q.question)
        if (!boxes) throw new Error('detect returned null')
        if (boxes.not_4_image_options) throw new Error('not 4_image_options')
        if (!['A','B','C','D'].every(o => Array.isArray(boxes[o]) && boxes[o].length === 4)) {
          throw new Error('invalid boxes')
        }

        // Crop & save (overwrite existing webps)
        for (const letter of ['A','B','C','D']) {
          const outName = `${exam}_${exam_code}_q${number}_opt_${letter}.webp`
          await cropAndSave(pngBuf, boxes[letter], path.join(IMG_OUT, outName))
        }
        // Update audit JSON with new boxes
        info.boxes = boxes
        fixed++
        console.log(`  ✓ ${exam}:${id} (${exam_code} Q${number})`)
      } catch (e) {
        failed++
        console.log(`  ✗ ${exam}:${id} (${exam_code} Q${number}): ${e.message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  // Write updated audit JSON for record
  fs.writeFileSync(AUDIT_FILE, JSON.stringify(audit, null, 2))

  console.log(`\n=== ${fixed} fixed, ${failed} failed ===`)
}

main().catch(e => { console.error(e); process.exit(1) })
