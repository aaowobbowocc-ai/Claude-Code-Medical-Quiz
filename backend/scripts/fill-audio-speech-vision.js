#!/usr/bin/env node
/**
 * Vision OCR fill — audio + speech 100-106 散落 234 題小缺.
 * Reuses fill-93-gaps-vision pattern: per-page OCR until all target Q nums found.
 * Cost est: ~$3-5 USD.
 */
require('dotenv').config()
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const fs = require('fs')
const path = require('path')
const { GoogleAuth } = require('google-auth-library')

const BACKEND = path.resolve(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')

const VERTEX_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0502672630'
const VERTEX_REGION = 'us-central1'
const VERTEX_MODEL = 'gemini-2.5-flash'  // pro 配額太緊，flash 速率/成本都更好
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }

// Auto-build targets: groups under 80 for years < 107
function buildTargets(file, examPrefix) {
  const data = JSON.parse(fs.readFileSync(path.join(BACKEND, file), 'utf-8'))
  const arr = data.questions || data
  const groups = new Map()
  for (const q of arr) {
    const k = q.roc_year + '|' + q.session + '|' + q.subject
    if (!groups.has(k)) groups.set(k, { qs: [], sample: q })
    groups.get(k).qs.push(q.number)
  }
  const targets = []
  for (const [k, info] of groups) {
    const [y, s, subj] = k.split('|')
    if (y >= '107') continue
    const expected = 80
    const missing = []
    for (let i = 1; i <= expected; i++) if (!info.qs.includes(i)) missing.push(i)
    if (missing.length > 0) targets.push({
      file, examPrefix, year: y, sess: s, subject: subj,
      code: info.sample.exam_code, tag: info.sample.subject_tag, missing,
    })
  }
  return targets
}

// Find PDF for a target by reading candidates' header for subject match
async function findQPdf(t) {
  const mupdf = await getMupdf()
  const subjKey = t.subject.slice(0, 4)
  const files = fs.readdirSync(PDF_CACHE).filter(f =>
    (f.startsWith(t.examPrefix + '_' + t.code + '_') || f.startsWith('Q_' + t.examPrefix + '_' + t.code + '_'))
    && !f.startsWith('A_') && !f.startsWith('S_') && !f.endsWith('_S.pdf') && !f.endsWith('_M.pdf')
  )
  for (const f of files) {
    try {
      const fp = path.join(PDF_CACHE, f)
      const buf = fs.readFileSync(fp)
      const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
      const head = doc.loadPage(0).toStructuredText('preserve-whitespace').asText().slice(0, 800).normalize('NFKC')
      if (head.includes(subjKey)) {
        const m = f.match(/_c(\w+)_s(\w+?)(?:_Q)?\.pdf$/)
        return { fp, file: f, c: m?.[1], s: m?.[2] }
      }
    } catch {}
  }
  return null
}

// Find answer PDF for the same c/s
function findAnsPdf(t, c, s) {
  const candidates = [
    `${t.examPrefix}_${t.code}_c${c}_s${s}_S.pdf`,
    `A_${t.examPrefix}_${t.code}_c${c}_s${s}.pdf`,
    `S_${t.examPrefix}_${t.code}_c${c}_s${s}.pdf`,
    `TS_${t.code}_c${c}_s${s}.pdf`,
  ]
  for (const c2 of candidates) {
    const fp = path.join(PDF_CACHE, c2)
    if (fs.existsSync(fp)) return fp
  }
  return null
}

async function parseAnswers(pdfPath) {
  if (!pdfPath) return {}
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) txt += doc.loadPage(i).toStructuredText('preserve-whitespace').asText() + '\n'
  txt = txt.normalize('NFKC')
  const answers = {}
  // Try full-width sequence
  const fw = /答案\s*([ＡＢＣＤ＃#]+)/g
  let m, n = 1
  while ((m = fw.exec(txt)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) answers[n++] = k; else n++
    }
  }
  if (Object.keys(answers).length >= 20) return answers
  // Half-width
  n = 1
  const hw = /答案\s*([A-D#]{10,})/gi
  while ((m = hw.exec(txt)) !== null) {
    for (const ch of m[1]) { if (/[A-D]/i.test(ch)) answers[n] = ch.toUpperCase(); n++ }
  }
  if (Object.keys(answers).length >= 20) return answers
  // Table format: 全 letter scan
  const letters = (txt.match(/(?<![A-Z0-9])[A-D#](?![A-Z0-9])/g) || [])
  if (letters.length >= 60) {
    for (let i = 0; i < Math.min(80, letters.length); i++) {
      if (letters[i] !== '#') answers[i + 1] = letters[i]
    }
  }
  return answers
}

async function visionExtract(pngBuf, needNums) {
  const tk = await auth.getAccessToken()
  const tokenStr = typeof tk === 'string' ? tk : tk.token
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`
  const prompt = `這是台灣國考試題 PDF 截圖。請抽取題目（特別需要：${needNums.join(', ')}），輸出嚴格 JSON 陣列：
[
  {"number": 數字, "question": "題目正文", "options": {"A":"...","B":"...","C":"...","D":"..."}},
  ...
]
規則：
- 只抽選擇題
- 題目正文要完整
- 不要 markdown、不要解釋
- 若這頁沒題目或無完整題目，輸出 []`
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
          generationConfig: { temperature: 0.0, maxOutputTokens: 6000, thinkingConfig: { thinkingBudget: 0 } },
        }),
      })
      if (resp.status === 429) { await new Promise(r => setTimeout(r, 5000 * 2 ** attempt)); continue }
      if (!resp.ok) { if (attempt === 4) return []; await new Promise(r => setTimeout(r, 3000)); continue }
      const data = await resp.json()
      const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
      const m = text.match(/\[[\s\S]*\]/)
      if (!m) return []
      try { return JSON.parse(m[0]) } catch { return [] }
    } catch { if (attempt === 2) return [] }
  }
  return []
}

async function main() {
  await getMupdf()
  const audio = buildTargets('questions-audiologist.json', 'audiologist')
  const speech = buildTargets('questions-speech-therapist.json', 'speech-therapist')
  const all = [...audio, ...speech]
  console.log(`Targets: ${all.length} | total missing: ${all.reduce((s, t) => s + t.missing.length, 0)}`)

  let grandAdded = 0
  for (const t of all) {
    const found = await findQPdf(t)
    if (!found) { console.log(`  ✗ ${t.year}-${t.sess} ${t.subject}: no Q PDF`); continue }
    const aPath = findAnsPdf(t, found.c, found.s)
    const answers = await parseAnswers(aPath)

    const mupdf = await getMupdf()
    const buf = fs.readFileSync(found.fp)
    const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
    const foundQs = new Map()
    for (let i = 0; i < doc.countPages() && foundQs.size < t.missing.length; i++) {
      const page = doc.loadPage(i)
      const px = page.toPixmap(mupdf.Matrix.scale(2.0, 2.0), mupdf.ColorSpace.DeviceRGB, false, true)
      const png = Buffer.from(px.asPNG())
      const need = t.missing.filter(n => !foundQs.has(n))
      if (!need.length) break
      const qs = await visionExtract(png, need)
      for (const q of qs) {
        if (!q.number || !q.question || !q.options) continue
        if (need.includes(q.number) && !foundQs.has(q.number)) foundQs.set(q.number, q)
      }
      await new Promise(r => setTimeout(r, 1000))  // pacing
    }

    // Insert
    const fp2 = path.join(BACKEND, t.file)
    const data = JSON.parse(fs.readFileSync(fp2, 'utf-8'))
    const arr = data.questions || data
    const existing = new Set(arr.filter(q => q.exam_code === t.code && q.subject === t.subject).map(q => q.number))
    let maxId = arr.reduce((m, q) => Math.max(m, parseInt(String(q.id).replace(/\D/g, '')) || 0), 0)
    let added = 0
    for (const [num, q] of foundQs) {
      if (existing.has(num)) continue
      if (!q.options.A || !q.options.B || !q.options.C || !q.options.D) continue
      const ans = answers[num]
      if (!ans || ans === '#') continue
      maxId++
      arr.push({
        id: maxId,
        roc_year: t.year, session: t.sess, exam_code: t.code,
        subject: t.subject, subject_tag: t.tag, subject_name: t.subject,
        stage_id: 0, number: num,
        question: q.question, options: q.options, answer: ans,
        explanation: '',
      })
      existing.add(num); added++
    }
    if (added > 0) {
      arr.sort((a, b) => {
        if (a.exam_code !== b.exam_code) return String(a.exam_code).localeCompare(String(b.exam_code))
        if (a.subject !== b.subject) return String(a.subject).localeCompare(String(b.subject))
        return (a.number || 0) - (b.number || 0)
      })
      fs.writeFileSync(fp2, JSON.stringify(data, null, 2))
    }
    console.log(`  ${t.year}-${t.sess} ${t.subject}: +${added}/${t.missing.length} (vision found ${foundQs.size}, ans keys ${Object.keys(answers).length})`)
    grandAdded += added
  }
  console.log(`\n=== TOTAL +${grandAdded} ===`)
}

main().catch(e => { console.error(e); process.exit(1) })
