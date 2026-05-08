#!/usr/bin/env node
/**
 * 修補三題 ABCD 重裁失敗的殘餘案例。
 *
 * pt 446: images[4] 已存在，直接 map 成 option_images
 * radiology 117819: 文字選項題（非 4 圖），OCR 還原文字
 * radiology 4945: 已有 option_images，OK
 */
require('dotenv/config')
const fs = require('fs')
const path = require('path')
const { GoogleAuth } = require('google-auth-library')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')
const VERTEX_PROJECT = 'gen-lang-client-0502672630'
const VERTEX_REGION = 'us-central1'
const VERTEX_MODEL = 'gemini-2.5-pro'
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')
const cleanText = s => (s || '').normalize('NFKC').replace(/[\s,，。、．.;；:：?？!！()（）「」『』《》<>《》【】\[\]]/g, '')

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }

async function renderPagePng(pdfPath, qnum, dbQHint, scale = 4) {
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
        const px = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true)
        return Buffer.from(px.asPNG())
      }
    }
  }
  return null
}

function findCandidatePdfs(exam, exam_code) {
  const allFiles = fs.readdirSync(PDF_CACHE).filter(f => f.endsWith('.pdf'))
  return allFiles.filter(f => {
    if (/^(TM|TS|M|S|A|TA)_/.test(f)) return false
    if (f.startsWith(`${exam}_${exam_code}_`)) return true
    if (new RegExp(`(?:^|_)Q_${exam_code}_c\\d+_s`).test(f)) return true
    return false
  })
}

async function ocrTextOptions(pngBuf, qnum, qStem) {
  const tk = await auth.getAccessToken()
  const tokenStr = (typeof tk === 'string') ? tk : tk.token
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`
  const prompt = `這是試題掃描頁。第 ${qnum} 題題幹：「${qStem.slice(0, 80)}」

請從圖中讀出此題 4 個 ABCD 選項的「文字內容」（這題選項是文字、不是圖片）。

只回 JSON：{"A": "...", "B": "...", "C": "...", "D": "..."}

注意：
- 完整逐字 OCR，含數學/符號/單位
- 排除 (A)(B)(C)(D) 標籤本身
- 不要含換行`

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

async function main() {
  // ── (1) pt 446: images[4] → option_images ──
  {
    const fp = path.join(BACKEND, 'questions-pt.json')
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
    const arr = data.questions || data
    const q = arr.find(x => x.id === 446 || x.id === '446')
    if (q && q.images && q.images.length >= 4) {
      q.option_images = { A: q.images[0], B: q.images[1], C: q.images[2], D: q.images[3] }
      q.options = { A: '(圖)', B: '(圖)', C: '(圖)', D: '(圖)' }
      delete q.image_url
      delete q.incomplete
      delete q.gap_reason
      fs.writeFileSync(fp, JSON.stringify(data, null, 2))
      console.log('✓ pt 446: images[4] → option_images')
    } else {
      console.log('✗ pt 446: not enough images')
    }
  }

  // ── (2) radiology 117819 (104020 Q54): OCR text options ──
  {
    const fp = path.join(BACKEND, 'questions-radiology.json')
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
    const arr = data.questions || data
    const q = arr.find(x => x.id === 117819 || x.id === '117819')
    if (q) {
      const candidates = findCandidatePdfs('radiology', q.exam_code)
      let png = null
      for (const f of candidates) {
        try {
          png = await renderPagePng(path.join(PDF_CACHE, f), q.number, q.question)
          if (png) break
        } catch {}
      }
      if (!png) {
        console.log('✗ radiology 117819: PDF not found')
      } else {
        const opts = await ocrTextOptions(png, q.number, q.question)
        if (opts && opts.A && opts.B && opts.C && opts.D) {
          q.options = { A: opts.A, B: opts.B, C: opts.C, D: opts.D }
          delete q.option_images
          delete q.image_url
          delete q.incomplete
          delete q.gap_reason
          // Delete the orphan _opt_*.webp files
          for (const letter of ['A','B','C','D']) {
            const orphan = path.join(BACKEND, '..', 'frontend', 'public', 'question-images', `radiology_${q.exam_code}_q${q.number}_opt_${letter}.webp`)
            try { fs.unlinkSync(orphan) } catch {}
          }
          fs.writeFileSync(fp, JSON.stringify(data, null, 2))
          console.log('✓ radiology 117819: OCR options', JSON.stringify(opts))
        } else {
          console.log('✗ radiology 117819: OCR failed', opts)
        }
      }
    }
  }

  // ── (3) radiology 4945 (113090 Q76): already OK, no-op ──
  console.log('— radiology 4945: existing option_images OK, skip')

  console.log('\nDONE')
}

main().catch(e => { console.error(e); process.exit(1) })
