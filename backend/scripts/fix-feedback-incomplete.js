#!/usr/bin/env node
/**
 * Vision OCR fix for 4 incomplete feedback questions:
 * - Q1: nursing 104-2 生理 Q27 (id 114519, paper basics, c=106 s=0501) — option B truncated
 * - Q7: doctor1 109-1 病理 Q99 (id 1150203084, doctor1 109020 c=301 s=22) — options empty
 * - Q8: medlab 110-2 血液 Q28 (id 2027, medlab 110100 c=308 s=22) — wrong subject + empty options
 * - Q11: nursing 108-2 社區 Q76 (id 3153, nursing 108110 c=106 s=0505) — options C/D suspected duplicate
 */
require('dotenv/config')
const fs = require('fs')
const path = require('path')
const { GoogleAuth } = require('google-auth-library')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const TARGETS = [
  { id: 114519, file: 'questions-nursing.json', pdf: 'nursing_Q_104100_c106_s0501.pdf', qnum: 27, label: 'Q1 護理 104-2 生理 Q27' },
  { id: 1150203084, file: 'questions.json', pdf: 'doctor1_109020_c301_s22.pdf', qnum: 99, label: 'Q7 醫師一 109-1 病理 Q99' },
  { id: 2027, file: 'questions-medlab.json', pdf: 'medlab_110100_c308_s22.pdf', qnum: 28, label: 'Q8 醫檢 110-2 Q28' },
  { id: 3153, file: 'questions-nursing.json', pdf: 'nursing_108110_c106_s0505.pdf', qnum: 76, label: 'Q11 護理 108-2 社區 Q76' },
]

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }
const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')

async function findQuestionPage(pdfPath, qnum) {
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  for (let i = 0; i < doc.countPages(); i++) {
    const t = stripPUA(doc.loadPage(i).toStructuredText('preserve-whitespace').asText())
    if (new RegExp(`(?:^|\\n)\\s*${qnum}[.、．]`).test(t)) return { doc, idx: i }
    if (new RegExp(`(?:^|\\n)\\s*${qnum}\\s*\\n`).test(t)) return { doc, idx: i }
  }
  return null
}

async function visionExtract(pngs, qnum) {
  const tk = await auth.getAccessToken()
  const tokenStr = (typeof tk === 'string') ? tk : tk.token
  const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/gen-lang-client-0502672630/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent`
  const parts = pngs.map(b => ({ inlineData: { data: b.toString('base64'), mimeType: 'image/png' } }))
  parts.push({ text: `請從圖中找出第 ${qnum} 題，輸出純 JSON：{"number":${qnum},"question":"完整題幹","options":{"A":"...","B":"...","C":"...","D":"..."}}` })
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 240000)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenStr}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.1, maxOutputTokens: 4096 } }),
        signal: ctrl.signal,
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(JSON.stringify(data).slice(0, 200))
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
      const m = text.match(/\{[\s\S]*\}/)
      if (m) return JSON.parse(m[0])
    } catch (e) { console.log('  err:', e.message.slice(0, 100)); await new Promise(r => setTimeout(r, 3000)) }
  }
  return null
}

async function main() {
  for (const t of TARGETS) {
    console.log(`\n=== ${t.label} ===`)
    const pdfPath = path.join(PDF_CACHE, t.pdf)
    if (!fs.existsSync(pdfPath)) { console.log('  ✗ PDF missing:', t.pdf); continue }
    const info = await findQuestionPage(pdfPath, t.qnum)
    if (!info) { console.log('  ✗ Q'+t.qnum+' page not found'); continue }
    console.log('  Q'+t.qnum+' on page', info.idx + 1)
    const mupdf = await getMupdf()
    const pages = [info.idx]
    if (info.idx + 1 < info.doc.countPages()) pages.push(info.idx + 1)
    const pngs = []
    for (const p of pages) {
      const px = info.doc.loadPage(p).toPixmap(mupdf.Matrix.scale(2.5, 2.5), mupdf.ColorSpace.DeviceRGB, false, true)
      pngs.push(Buffer.from(px.asPNG()))
    }
    const v = await visionExtract(pngs, t.qnum)
    if (!v || !v.options || Object.keys(v.options).length !== 4) {
      console.log('  ✗ vision incomplete:', JSON.stringify(v).slice(0, 150))
      continue
    }
    if (Object.values(v.options).some(o => !o || o.length < 1)) {
      console.log('  ✗ empty option:', JSON.stringify(v.options))
      continue
    }
    // Update JSON
    const filePath = path.join(BACKEND, t.file)
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const arr = data.questions || data
    const q = arr.find(x => x.id === t.id || x.id === String(t.id))
    if (!q) { console.log('  ✗ not in JSON'); continue }
    q.question = v.question
    q.options = v.options
    delete q.incomplete
    delete q.gap_reason
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
    console.log(`  ✓ updated #${t.id} | options: A="${v.options.A.slice(0,20)}" B="${v.options.B.slice(0,20)}"`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
