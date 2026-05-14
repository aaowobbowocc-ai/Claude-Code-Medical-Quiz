#!/usr/bin/env node
/**
 * Vision OCR fill — gsat 100 國文/社會/自然
 * 100 年 PDF 格式 ≠ 105+，沒有 (A)(B)(C)(D) 標記，需 Vision OCR。
 */
require('dotenv').config()
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const fs = require('fs')
const path = require('path')
const { GoogleAuth } = require('google-auth-library')

const BACKEND = path.resolve(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')
const VERTEX_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0502672630'
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const TARGETS = [
  { tag: 'science', subject: '自然', qPdf: 'gsat_100_science.pdf',
    aUrl: 'https://www.ceec.edu.tw/files/file_pool/1/0j076520808175240837/100%e5%ad%b8%e6%b8%ac%e8%87%aa%e7%84%b6%e5%8f%83%e8%80%83%e7%ad%94%e6%a1%88%e5%ae%9a%e7%a8%bf.pdf',
    expected: 60 },
]

const https = require('https')
function download(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
      if (r.statusCode === 302 || r.statusCode === 301) {
        const loc = r.headers.location
        return download(loc.startsWith('http') ? loc : 'https://www.ceec.edu.tw' + loc).then(res, rej)
      }
      const c = []; r.on('data', d => c.push(d)); r.on('end', () => res(Buffer.concat(c)))
    }).on('error', rej)
  })
}

async function parseAnswers(buf) {
  const pdfParse = require('pdf-parse')
  const data = await pdfParse(buf)
  const text = data.text
  const answers = {}
  // 100 年自然 5 選 1，answer 包含 E
  const letters = (text.match(/(?<![A-Z0-9])[A-E](?![A-Z0-9])/g) || [])
  for (let i = 0; i < letters.length && i < 100; i++) {
    answers[i + 1] = letters[i]
  }
  return answers
}

async function visionExtract(pngBuf) {
  const tk = await auth.getAccessToken()
  const tokenStr = typeof tk === 'string' ? tk : tk.token
  const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent`
  const prompt = `這是台灣學測試題 PDF 截圖。請抽取所有單選題，輸出 JSON 陣列：
[{"number": N, "question": "題目正文", "options": {"A":"...","B":"...","C":"...","D":"...","E":"..."}}]
規則：
- 選項可能是 4 個 (A-D) 或 5 個 (A-E)，都要抽
- 題組共用題幹時，每題的 question 包含完整題幹
- 圖表內容用文字描述
- 多選題（題幹明示為多選或複選）跳過
- 不要 markdown、不要解釋
- 若該頁無題目則輸出 []`
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenStr}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            { inlineData: { data: pngBuf.toString('base64'), mimeType: 'image/png' } },
            { text: prompt },
          ] }],
          generationConfig: { temperature: 0.0, maxOutputTokens: 8000 },
        }),
      })
      if (resp.status === 429) { await new Promise(r => setTimeout(r, 5000 * 2 ** attempt)); continue }
      if (!resp.ok) { if (attempt === 4) return []; await new Promise(r => setTimeout(r, 3000)); continue }
      const data = await resp.json()
      const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
      const m = text.match(/\[[\s\S]*\]/)
      if (!m) return []
      try { return JSON.parse(m[0]) } catch { return [] }
    } catch { if (attempt === 4) return [] }
  }
  return []
}

async function main() {
  const mupdf = await import('mupdf')
  const fp = path.join(BACKEND, 'questions-gsat.json')
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data
  let maxId = arr.reduce((m, q) => Math.max(m, parseInt(String(q.id).replace(/\D/g, '')) || 0), 0)
  let totalAdded = 0

  for (const t of TARGETS) {
    const qPath = path.join(PDF_CACHE, t.qPdf)
    if (!fs.existsSync(qPath)) { console.log(`✗ no Q PDF: ${t.qPdf}`); continue }
    const aBuf = await download(t.aUrl)
    const answers = await parseAnswers(aBuf)
    console.log(`\n=== 100-${t.subject} | ans keys: ${Object.keys(answers).length} | expected ~${t.expected} ===`)

    const buf = fs.readFileSync(qPath)
    const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
    const foundAll = new Map()
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i)
      const px = page.toPixmap(mupdf.Matrix.scale(2.0, 2.0), mupdf.ColorSpace.DeviceRGB, false, true)
      const png = Buffer.from(px.asPNG())
      const qs = await visionExtract(png)
      for (const q of qs) {
        if (!q.number || !q.question || !q.options) continue
        if (!q.options.A || !q.options.B || !q.options.C || !q.options.D) continue
        if (q.number < 1 || q.number > 100) continue
        // 100 年自然 5 選 1，存全部 5 選項以保留答案 E 的題目
        const opts = { A: q.options.A, B: q.options.B, C: q.options.C, D: q.options.D }
        if (q.options.E) opts.E = q.options.E
        if (!foundAll.has(q.number)) foundAll.set(q.number, { ...q, options: opts })
      }
      await new Promise(r => setTimeout(r, 800))
    }
    console.log(`  Vision found ${foundAll.size}`)

    const existing = new Set(arr.filter(q => q.roc_year === '100' && q.subject === t.subject).map(q => q.number))
    let added = 0
    for (const [num, q] of foundAll) {
      if (existing.has(num)) continue
      const ans = answers[num]
      if (!ans || !'ABCDE'.includes(ans)) { console.log(`  #${num}: no answer`); continue }
      maxId++
      arr.push({
        id: `gsat_100_${t.tag}_${String(num).padStart(3, '0')}`,
        roc_year: '100',
        session: '第一次',
        exam_code: 'gsat_100',
        subject: t.subject,
        subject_tag: t.tag,
        subject_name: t.subject,
        stage_id: 0,
        number: num,
        question: q.question,
        options: q.options,
        answer: ans,
        explanation: '',
      })
      existing.add(num); added++
    }
    console.log(`  +${added}`)
    totalAdded += added
  }

  arr.sort((a, b) => {
    const ya = String(a.roc_year), yb = String(b.roc_year)
    if (ya !== yb) return ya.localeCompare(yb)
    if (a.subject !== b.subject) return String(a.subject).localeCompare(String(b.subject))
    return (a.number || 0) - (b.number || 0)
  })
  fs.writeFileSync(fp, JSON.stringify(data, null, 2))
  console.log(`\nTOTAL +${totalAdded}`)
}

main().catch(e => { console.error(e); process.exit(1) })
