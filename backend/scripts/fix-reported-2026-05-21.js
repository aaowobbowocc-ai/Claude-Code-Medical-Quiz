#!/usr/bin/env node
// 修正 2026-05-21 使用者回報的 7 題解析錯誤（選項缺漏/跑版）。
// Vertex AI vision OCR 重新擷取題目+選項，答案 PDF 重新比對。
//
// Usage: node scripts/fix-reported-2026-05-21.js [--apply]

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')
const { GoogleAuth } = require('google-auth-library')

const ROOT = path.resolve(__dirname, '..')
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const VERTEX_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0502672630'
const VERTEX_REGION = 'us-central1'
const VERTEX_MODEL = 'gemini-2.5-flash'
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
const APPLY = process.argv.includes('--apply')

// file, id, code, c, s, number
const TARGETS = [
  { file: 'questions-medlab.json', id: '6850',      code: '107100', c: '308', s: '33',   number: 1 },
  { file: 'questions-medlab.json', id: '5525',      code: '106020', c: '308', s: '44',   number: 6 },
  { file: 'questions-medlab.json', id: '13440',     code: '100140', c: '104', s: '0107', number: 12 },
  { file: 'questions-medlab.json', id: '6179',      code: '106100', c: '308', s: '66',   number: 28 },
  { file: 'questions-medlab.json', id: '14203',     code: '101110', c: '108', s: '0504', number: 32 },
  { file: 'questions-medlab.json', id: '100140052', code: '100140', c: '104', s: '0107', number: 52 },
  // doctor1 1150204199：PDF 題號與 DB number 不一致（醫學一 100 題合卷重新編號），改用內容比對另處理
]

function download(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized: false, timeout: 25000,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(String(res.statusCode))) }
      const cs = []; res.on('data', c => cs.push(c)); res.on('end', () => resolve(Buffer.concat(cs)))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

function parseAnswers(text) {
  const ans = {}
  const fw = /答案\s*([ＡＢＣＤ]+)/g
  let m, n = 1
  while ((m = fw.exec(text)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) ans[n++] = k
    }
  }
  if (Object.keys(ans).length >= 5) return ans
  n = 1
  const hw = /答案\s*([A-D]{5,})/g
  while ((m = hw.exec(text)) !== null) for (const ch of m[1]) ans[n++] = ch
  if (Object.keys(ans).length >= 5) return ans
  let cleaned = text.replace(/第\d{1,3}題/g, '').replace(/題號/g, '').replace(/答案/g, '')
    .replace(/標準/g, '').replace(/[\s\n\r]+/g, '')
  let idx = 1
  for (const ch of cleaned) if ('ABCD'.includes(ch)) ans[idx++] = ch
  return ans
}

async function geminiRequest(body) {
  const tk = await auth.getAccessToken()
  const token = typeof tk === 'string' ? tk : tk.token
  const p = `/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}` +
    `/publishers/google/models/${VERTEX_MODEL}:generateContent`
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = https.request({ hostname: `${VERTEX_REGION}-aiplatform.googleapis.com`,
      path: p, method: 'POST', headers: { 'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`, 'Content-Length': Buffer.byteLength(data) } }, res => {
      let chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 250)}`))
        try { resolve(JSON.parse(text)) } catch { reject(new Error('bad JSON')) }
      })
    })
    req.on('error', reject)
    req.write(data); req.end()
  })
}

async function visionExtractQ(png, num) {
  const prompt = `這是台灣國家考試試題 PDF 的一頁掃描影像。請只擷取「第 ${num} 題」這一題（單選題）。
若這一頁沒有第 ${num} 題或不完整，回傳 {}。
回傳嚴格 JSON（不要 markdown 圍欄、不要說明）：
{"question":"<題幹完整文字，繁體中文，含英文照抄>","options":{"A":"<文字>","B":"<文字>","C":"<文字>","D":"<文字>"}}
規則：選項標記 (A)(B)(C)(D) 或 ＡＢＣＤ 對應 A/B/C/D；題號不要放進 question；若題目附圖無法以文字表達，question 後標註「（此題含圖）」；不可杜撰。`
  const body = {
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: 'image/png', data: png.toString('base64') } },
      { text: prompt },
    ] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
  }
  const resp = await geminiRequest(body)
  const raw = (resp.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('')
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  try { return JSON.parse(cleaned) } catch { return {} }
}

function valid(e) {
  if (!e || typeof e.question !== 'string' || e.question.length < 6) return false
  if (!e.options) return false
  return ['A', 'B', 'C', 'D'].every(k => typeof e.options[k] === 'string' && e.options[k].trim())
}

async function main() {
  const mupdf = await import('mupdf')
  const fileCache = {}
  const load = fp => fileCache[fp] || (fileCache[fp] = JSON.parse(fs.readFileSync(path.join(ROOT, fp), 'utf-8')))
  let fixed = 0

  for (const t of TARGETS) {
    console.log(`\n▶ ${t.file} id=${t.id}  (${t.code} c=${t.c} s=${t.s} #${t.number})`)
    const data = load(t.file)
    const list = Array.isArray(data) ? data : data.questions
    const row = list.find(q => String(q.id) === t.id)
    if (!row) { console.log('  ✗ id 不在題庫'); continue }

    let qbuf, abuf
    try { qbuf = await download(`${BASE}?t=Q&code=${t.code}&c=${t.c}&s=${t.s}&q=1`) }
    catch (e) { console.log(`  ✗ Q PDF: ${e.message}`); continue }
    try { abuf = await download(`${BASE}?t=S&code=${t.code}&c=${t.c}&s=${t.s}&q=1`) }
    catch { abuf = null }
    const answers = abuf ? parseAnswers((await pdfParse(abuf)).text) : {}

    const doc = mupdf.Document.openDocument(new Uint8Array(qbuf), 'application/pdf')
    let found = null
    for (let i = 0; i < doc.countPages() && !found; i++) {
      const px = doc.loadPage(i).toPixmap(mupdf.Matrix.scale(2.2, 2.2), mupdf.ColorSpace.DeviceRGB, false, true)
      const e = await visionExtractQ(Buffer.from(px.asPNG()), t.number)
      if (valid(e)) found = e
      await sleep(700)
    }
    if (!found) { console.log('  ✗ vision 未取得'); continue }
    const ans = answers[t.number]
    console.log('  舊 Q:', JSON.stringify(row.question).slice(0, 70))
    console.log('  新 Q:', JSON.stringify(found.question).slice(0, 70))
    console.log('  新選項:', ['A','B','C','D'].map(k => k + '=' + found.options[k]).join(' | ').slice(0, 160))
    console.log('  答案 PDF:', ans || '(無)', ' 舊答案:', row.answer)
    if (APPLY) {
      row.question = found.question
      row.options = { A: found.options.A, B: found.options.B, C: found.options.C, D: found.options.D }
      if (ans && /^[ABCD]$/.test(ans)) row.answer = ans
      fixed++
    }
  }

  if (APPLY && fixed) {
    for (const fp of Object.keys(fileCache)) {
      const abs = path.join(ROOT, fp)
      const tmp = abs + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(fileCache[fp], null, 2))
      fs.renameSync(tmp, abs)
      console.log(`\n✅ ${fp} 已寫入`)
    }
  }
  console.log(`\n${APPLY ? '✅ 修正' : '(dry-run) 可修正'} ${fixed} 題`)
}
main().catch(e => { console.error(e); process.exit(1) })
