#!/usr/bin/env node
// Vision-OCR backfill for civil-service gaps that text parsers cannot handle:
//   - civil-senior 國文（測驗）103-105  (markerless poetry-option MCQ)
//   - common_law_knowledge 普考 103-105 英文段  (English cloze/passage)
//   - customs 104 英文 殘題
// Renders PDF pages to PNG via mupdf, extracts MCQ with Gemini 2.5 Flash.
//
// Usage: node scripts/fill-civil-vision.js [--target <id>] [--apply]

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')
const { GoogleAuth } = require('google-auth-library')

const ROOT = path.resolve(__dirname, '..')
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

// Vertex AI (OAuth via ADC) — Gemini API keys are dead, use Vertex.
const VERTEX_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0502672630'
const VERTEX_REGION = 'us-central1'
const VERTEX_MODEL = 'gemini-2.5-flash'
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const APPLY = process.argv.includes('--apply')
const TARGET_FILTER = process.argv.find((_, i) => process.argv[i - 1] === '--target') || null

// ─── Targets ───
// kind: 'exam' → questions-<file>.json ; 'bank' → shared-banks/<file>.json
const TARGETS = [
  { id: 'civil-senior-chinese', kind: 'exam', file: 'questions-civil-senior.json',
    sessions: [
      { year: '103', code: '103080', c: '201', s: '0101' },
      { year: '104', code: '104080', c: '201', s: '0101' },
      { year: '105', code: '105080', c: '201', s: '0101' },
    ],
    subject: '國文（測驗）', tag: 'chinese', maxQ: 10, mcqOnly: '測驗' },
  { id: 'customs-english', kind: 'exam', file: 'questions-customs.json',
    sessions: [ { year: '104', code: '104050', c: '101', s: '0201' } ],
    subject: '英文', tag: 'english', maxQ: 50 },
  { id: 'law-knowledge-junior', kind: 'bank', file: 'common_law_knowledge.json',
    sessions: [
      { year: '103', code: '103080', c: '401', s: '0112' },
      { year: '104', code: '104080', c: '401', s: '0112' },
      { year: '105', code: '105080', c: '401', s: '0216' },
    ],
    subject: '法學知識與英文（包括中華民國憲法、法學緒論、英文）', tag: 'law_knowledge_combined',
    maxQ: 50, sourceCode: 'civil-junior-general', level: 'junior',
    sourceName: y => `${y} 年普通考試一般行政` },
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
  const pathStr = `/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}` +
    `/publishers/google/models/${VERTEX_MODEL}:generateContent`
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = https.request({
      hostname: `${VERTEX_REGION}-aiplatform.googleapis.com`, path: pathStr, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`))
        try { resolve(JSON.parse(text)) } catch { reject(new Error('bad JSON')) }
      })
    })
    req.on('error', reject)
    req.write(data); req.end()
  })
}

async function visionExtract(png) {
  const prompt = `This is a scan of a Taiwan national civil-service exam paper (繁體中文，可能含英文題). Extract every single-choice (單選) question visible on this page.
Return STRICT JSON array (no prose, no markdown fence):
[{"number": <int>, "question": "<stem>", "options": {"A":"<text>","B":"<text>","C":"<text>","D":"<text>"}}]
Rules:
- Only the 測驗題/選擇題 (single-choice) section. Skip 申論題/作文/公文 essay parts.
- Options may be unlabelled paragraphs in reading order → map first 4 to A/B/C/D.
- Preserve traditional Chinese exactly; keep English text as-is. Do NOT translate.
- Question number is the leading number of each item; do not put it in "question".
- For 題組 (passage-based) questions, include the shared passage at the start of each question's stem.
- If a question is unreadable, omit it. Do not invent.
- Return ONLY the JSON array.`
  const body = {
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: 'image/png', data: png.toString('base64') } },
      { text: prompt },
    ] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  }
  const resp = await geminiRequest(body)
  const raw = (resp.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('')
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  if (!cleaned) return []
  try { const j = JSON.parse(cleaned); return Array.isArray(j) ? j : [] }
  catch { console.warn('  [parse-fail]', cleaned.slice(0, 150)); return [] }
}

function validQ(q, maxQ) {
  if (!q || typeof q.number !== 'number' || q.number < 1 || q.number > maxQ) return false
  if (typeof q.question !== 'string' || q.question.length < 6) return false
  if (!q.options) return false
  for (const L of ['A', 'B', 'C', 'D']) if (typeof q.options[L] !== 'string' || !q.options[L].trim()) return false
  return true
}

async function main() {
  const mupdf = await import('mupdf')
  let grandAdded = 0

  for (const t of TARGETS) {
    if (TARGET_FILTER && t.id !== TARGET_FILTER) continue
    console.log(`\n══ ${t.id} (${t.kind}: ${t.file}) ══`)
    const filePath = t.kind === 'bank' ? path.join(ROOT, 'shared-banks', t.file) : path.join(ROOT, t.file)
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    const list = data.questions || data

    for (const sess of t.sessions) {
      // existing numbers for this session
      let have
      if (t.kind === 'bank') {
        have = new Set(list.filter(q => q.roc_year === sess.year && q.subject_tags?.includes(t.tag))
          .map(q => q.number))
      } else {
        have = new Set(list.filter(q => q.exam_code === sess.code && q.subject_tag === t.tag)
          .map(q => q.number))
      }
      const missingBefore = []
      for (let i = 1; i <= t.maxQ; i++) if (!have.has(i)) missingBefore.push(i)
      if (!missingBefore.length) { console.log(`  ${sess.year}: 已滿`); continue }
      console.log(`  ${sess.year}: 缺 ${missingBefore.length} 題 [${missingBefore.join(',')}]`)

      let qbuf, abuf
      try { qbuf = await download(`${BASE}?t=Q&code=${sess.code}&c=${sess.c}&s=${sess.s}&q=1`) }
      catch (e) { console.log(`    ✗ Q: ${e.message}`); continue }
      try { abuf = await download(`${BASE}?t=S&code=${sess.code}&c=${sess.c}&s=${sess.s}&q=1`) }
      catch { abuf = null }
      const answers = abuf ? parseAnswers((await pdfParse(abuf)).text) : {}

      const doc = mupdf.Document.openDocument(new Uint8Array(qbuf), 'application/pdf')
      const found = new Map()
      for (let i = 0; i < doc.countPages(); i++) {
        const px = doc.loadPage(i).toPixmap(mupdf.Matrix.scale(2.2, 2.2), mupdf.ColorSpace.DeviceRGB, false, true)
        const qs = await visionExtract(Buffer.from(px.asPNG()))
        for (const q of qs) {
          if (!validQ(q, t.maxQ)) continue
          if (!found.has(q.number)) found.set(q.number, q)
        }
        await sleep(900)
      }
      console.log(`    vision 抓到 ${found.size} 題`)

      // ── merge ──
      let added = 0
      let nextId = t.kind === 'exam'
        ? Math.max(0, ...list.map(q => Number(q.id) || 0)) + 1 : null
      for (const num of missingBefore) {
        const q = found.get(num)
        if (!q) continue
        const ans = answers[num]
        if (!ans || !'ABCD'.includes(ans)) { console.log(`    #${num}: 無答案，跳過`); continue }
        const opts = { A: q.options.A, B: q.options.B, C: q.options.C, D: q.options.D }
        if (t.kind === 'bank') {
          list.push({
            id: `${t.file.replace('.json', '')}-${sess.year}-${t.sourceCode}-${num}`,
            roc_year: sess.year, session: '第一次', source_exam_code: t.sourceCode,
            source_exam_name: t.sourceName(sess.year), subject: t.subject,
            subject_tags: [t.tag], number: num, question: q.question, options: opts,
            answer: ans, level: t.level, shared_bank: t.file.replace('.json', ''),
            parent_id: null, case_context: null, is_deprecated: false, deprecated_reason: null,
          })
        } else {
          list.push({
            id: nextId++, roc_year: sess.year, session: '第一次', exam_code: sess.code,
            subject: t.subject, subject_tag: t.tag, subject_name: t.subject, stage_id: 0,
            number: num, question: q.question, options: opts, answer: ans, explanation: '',
          })
        }
        added++; grandAdded++
        console.log(`    + #${num} ${ans}  ${q.question.slice(0, 32)}`)
      }
      console.log(`    ${sess.year}: +${added}`)
    }

    if (APPLY) {
      if (data.total !== undefined) data.total = list.length
      if (data.bankVersion !== undefined) {
        data.bankVersion = (Number(data.bankVersion) || 0) + 1
        data.last_synced_at = new Date().toISOString()
      }
      const tmp = filePath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
      fs.renameSync(tmp, filePath)
      console.log(`  ✅ ${t.file} 已寫入`)
    }
  }
  console.log(`\n${APPLY ? '✅' : '(dry-run)'} 總計 +${grandAdded} 題`)
}
main().catch(e => { console.error(e); process.exit(1) })
