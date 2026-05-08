#!/usr/bin/env node
/**
 * One-shot: Fix incomplete questions via Vision OCR
 *
 * Targets:
 *   doctor1 100030 醫學(一) Q73  — option D missing
 *   doctor1 100030 醫學(一) Q78  — option B missing
 *   doctor1 100030 醫學(二) Q41  — option B missing
 *   doctor2 102030 醫學(三) Q63  — question text truncated
 *   doctor2 107080 醫學(三) Q39  — question text truncated
 */

require('dotenv/config')
const fs   = require('fs')
const path = require('path')
const https = require('https')
const { GoogleAuth } = require('google-auth-library')

const BACKEND = path.join(__dirname, '..')
const CACHE   = path.join(BACKEND, '.pdf-cache')
if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE)

const BASE           = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const VERTEX_PROJECT = 'gen-lang-client-0502672630'
const VERTEX_REGION  = 'us-central1'
const VERTEX_MODEL   = 'gemini-2.5-pro'
const vertexAuth     = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ─── PDF download ──────────────────────────────────────────────────────────────
async function fetchPdf(url) {
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({ rejectUnauthorized: false })
    https.get(url, { agent }, res => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        const loc = res.headers.location || ''
        if (loc.includes('NotFound') || loc.includes('Error')) return reject(new Error(`Redirect to ${loc}`))
        return reject(new Error(`Unexpected redirect to ${loc}`))
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`))
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
  })
}

async function cachedPdf(code, c, s) {
  const fpath = path.join(CACHE, `doctor_${code}_c${c}_s${s}.pdf`)
  try { const buf = fs.readFileSync(fpath); if (buf.length > 1000) { console.log(`  (cached) ${buf.length} bytes`); return buf } } catch {}
  const url = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
  console.log(`  Downloading: ${url}`)
  const buf = await fetchPdf(url)
  fs.writeFileSync(fpath, buf)
  console.log(`  (fetched) ${buf.length} bytes`)
  return buf
}

// ─── PDF → PNG pages ──────────────────────────────────────────────────────────
async function pdfToPageImages(buf, dpi = 144) {
  const mupdf = await import('mupdf')
  const doc   = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n     = doc.countPages()
  const scale = dpi / 72
  const images = []
  for (let i = 0; i < n; i++) {
    const page   = doc.loadPage(i)
    const matrix = mupdf.Matrix.scale(scale, scale)
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true)
    images.push(Buffer.from(pixmap.asPNG()))
  }
  console.log(`  ${n} pages rendered`)
  return images
}

// ─── Vertex AI Vision ─────────────────────────────────────────────────────────
async function visionExtract(pngBuf, prompt, pageNum) {
  const base64 = pngBuf.toString('base64')
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const token = await vertexAuth.getAccessToken()
      const body  = {
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
      const text  = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
      const match = text.match(/[\[{][\s\S]*[\]}]/)
      if (!match) return null
      return JSON.parse(match[0])
    } catch (e) {
      if (attempt >= 2) { console.log(`    Page ${pageNum}: Vision failed: ${e.message}`); return null }
      await sleep(2000 * (attempt + 1))
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const JOBS = [
  {
    label: '100030 醫學(一)',
    code: '100030', c: '101', s: '0101',
    file: 'questions.json', structKey: 'questions',
    exam_code: '100030', subject: '醫學(一)',
    targets: [
      { number: 73, fixType: 'empty_option', emptyOpts: ['D'] },
      { number: 78, fixType: 'empty_option', emptyOpts: ['B'] },
    ],
  },
  {
    label: '100030 醫學(二)',
    code: '100030', c: '101', s: '0102',
    file: 'questions.json', structKey: 'questions',
    exam_code: '100030', subject: '醫學(二)',
    targets: [
      { number: 41, fixType: 'empty_option', emptyOpts: ['B'] },
    ],
  },
  {
    label: '102030 醫學(三)',
    code: '102030', c: '102', s: '0103',
    file: 'questions-doctor2.json', structKey: 'questions',
    exam_code: '102030', subject: '醫學(三)',
    targets: [
      { number: 63, fixType: 'truncated' },
    ],
  },
  {
    label: '107080 醫學(三)',
    code: '107080', c: '302', s: '11',
    file: 'questions-doctor2.json', structKey: 'questions',
    exam_code: '107080', subject: '醫學(三)',
    targets: [
      { number: 39, fixType: 'truncated' },
    ],
  },
]

const PROMPT = `這是台灣國家考試試題掃描圖片。
請將所有可見的單選題完整抽出（題號、題目、四個選項A/B/C/D）。
只輸出純 JSON 陣列：[{"number":1,"question":"...","options":{"A":"...","B":"...","C":"...","D":"..."}}]
若選項是圖表/圖片無法辨識，對應選項填入"[圖]"。`

async function processJob(job) {
  console.log(`\n═══ ${job.label} ═══`)
  const remaining = new Map(job.targets.map(t => [t.number, t]))

  const buf    = await cachedPdf(job.code, job.c, job.s)
  const pages  = await pdfToPageImages(buf)
  const found  = {}

  for (let i = 0; i < pages.length && remaining.size > 0; i++) {
    const pageNum = i + 1
    process.stdout.write(`    Page ${pageNum}/${pages.length}... `)
    const qs = await visionExtract(pages[i], PROMPT, pageNum)
    if (!qs) { console.log('(no result)'); continue }
    const hits = []
    for (const q of qs) {
      if (remaining.has(q.number)) {
        hits.push(q.number)
        found[q.number] = q
        remaining.delete(q.number)
      }
    }
    console.log(`${qs.length} qs${hits.length ? ', found: Q' + hits.join(',Q') : ''}`)
  }

  if (Object.keys(found).length === 0) {
    console.log('  ✗ No targets found')
    return 0
  }

  // Load and patch JSON
  const filePath = path.join(BACKEND, job.file)
  const raw      = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const arr      = job.structKey ? raw[job.structKey] : raw
  let patched    = 0

  for (const [numStr, ocr] of Object.entries(found)) {
    const num = parseInt(numStr)
    const tgt = job.targets.find(t => t.number === num)
    const idx = arr.findIndex(q => q.exam_code === job.exam_code && q.subject === job.subject && q.number === num)
    if (idx < 0) { console.log(`  ✗ Q${num} not found in JSON`); continue }

    const q = arr[idx]
    if (tgt.fixType === 'empty_option') {
      let changed = false
      for (const opt of tgt.emptyOpts) {
        const val = ocr.options?.[opt]
        if (val && val !== '[圖]') {
          q.options[opt] = val
          console.log(`  ✓ Q${num} option ${opt} = "${val.substring(0,60)}"`)
          changed = true
        } else {
          console.log(`  ✗ Q${num} option ${opt} still missing or image`)
        }
      }
      // Clear incomplete flag if no more empty options
      if (changed) {
        const stillEmpty = Object.values(q.options).filter(v => !v)
        if (stillEmpty.length === 0) { delete q.incomplete; patched++ }
        else patched++
      }
    } else if (tgt.fixType === 'truncated') {
      if (ocr.question && ocr.question.length > q.question.length) {
        console.log(`  ✓ Q${num} question extended: ${q.question.length} → ${ocr.question.length} chars`)
        q.question = ocr.question
        delete q.incomplete
        patched++
      } else {
        console.log(`  ✗ Q${num} OCR question not longer (${ocr.question?.length} vs ${q.question.length})`)
      }
    }
  }

  if (patched > 0) {
    const toSave = job.structKey ? raw : arr
    fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2))
    console.log(`  💾 Saved ${job.file} (${patched} patched)`)
  }
  return patched
}

async function main() {
  let total = 0
  for (const job of JOBS) {
    total += await processJob(job)
  }
  console.log(`\n總計: ${total} questions patched`)
}

main().catch(e => { console.error(e); process.exit(1) })
