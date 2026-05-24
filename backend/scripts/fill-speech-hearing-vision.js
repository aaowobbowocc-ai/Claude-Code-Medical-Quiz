#!/usr/bin/env node
/**
 * speech 聽力學與輔助溝通系統 剩 10 題 — 直接指定 PDF 路徑。
 * PDF 原叫「溝通障礙總論」(舊名)，後改為「聽力學與輔助溝通系統」。
 */
require('dotenv').config()
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const fs = require('fs')
const path = require('path')
const { GoogleAuth } = require('google-auth-library')

const BACKEND = path.resolve(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')
const VERTEX_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0502672630'
const VERTEX_MODEL = 'gemini-2.5-flash'
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const TARGETS = [
  { code: '100090', sess: '第一次', year: '100', qPdf: 'speech-therapist_100090_c201_s0406.pdf', aPdf: 'A_speech-therapist_100090_c201_s0406.pdf', miss: [79, 80] },
  { code: '101070', sess: '第一次', year: '101', qPdf: 'speech-therapist_101070_c201_s0406.pdf', aPdf: 'A_speech-therapist_101070_c201_s0406.pdf', miss: [55, 56, 60] },
  { code: '102030', sess: '第一次', year: '102', qPdf: 'speech-therapist_102030_c114_s1006.pdf', aPdf: 'A_speech-therapist_102030_c114_s1006.pdf', miss: [80] },
  { code: '102110', sess: '第二次', year: '102', qPdf: 'speech-therapist_102110_c114_s1006.pdf', aPdf: 'A_speech-therapist_102110_c114_s1006.pdf', miss: [60] },
  { code: '103100', sess: '第一次', year: '103', qPdf: 'speech-therapist_103100_c112_s0806.pdf', aPdf: 'A_speech-therapist_103100_c112_s0806.pdf', miss: [41] },
  { code: '104100', sess: '第一次', year: '104', qPdf: 'speech-therapist_104100_c109_s0806.pdf', aPdf: 'A_speech-therapist_104100_c109_s0806.pdf', miss: [3, 24] },
]
const SUBJECT = '聽力學與輔助溝通系統（包括專業倫理）'
const TAG = 'paper6'

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }

async function parseAnswers(pdfPath) {
  if (!fs.existsSync(pdfPath)) return {}
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) txt += doc.loadPage(i).toStructuredText('preserve-whitespace').asText() + '\n'
  txt = txt.normalize('NFKC')
  const answers = {}
  const fw = /答案\s*([ＡＢＣＤ＃#]+)/g
  let m, n = 1
  while ((m = fw.exec(txt)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) answers[n++] = k; else n++
    }
  }
  if (Object.keys(answers).length >= 20) return answers
  // Letter scan fallback
  const letters = (txt.match(/(?<![A-Z0-9])[A-D#](?![A-Z0-9])/g) || [])
  if (letters.length >= 60) {
    for (let i = 0; i < Math.min(80, letters.length); i++) {
      if (letters[i] !== '#') answers[i + 1] = letters[i]
    }
  }
  return answers
}

async function visionExtract(pngBuf) {
  const tk = await auth.getAccessToken()
  const tokenStr = typeof tk === 'string' ? tk : tk.token
  const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/us-central1/publishers/google/models/${VERTEX_MODEL}:generateContent`
  const prompt = `這是台灣國考試題 PDF 截圖。請抽取所有題目，輸出 JSON 陣列：
[{"number": N, "question": "...", "options": {"A":"...","B":"...","C":"...","D":"..."}}]
只輸出 JSON，無 markdown。若無完整題目，輸出 []`
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
    } catch { if (attempt === 4) return [] }
  }
  return []
}

async function main() {
  await getMupdf()
  const fp = path.join(BACKEND, 'questions-speech-therapist.json')
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data
  let maxId = arr.reduce((m, q) => Math.max(m, parseInt(String(q.id).replace(/\D/g, '')) || 0), 0)
  let total = 0

  for (const t of TARGETS) {
    const qPath = path.join(PDF_CACHE, t.qPdf)
    const aPath = path.join(PDF_CACHE, t.aPdf)
    if (!fs.existsSync(qPath)) { console.log('✗ no Q:', t.qPdf); continue }
    const answers = await parseAnswers(aPath)

    const mupdf = await getMupdf()
    const buf = fs.readFileSync(qPath)
    const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
    const found = new Map()
    for (let i = 0; i < doc.countPages() && found.size < t.miss.length; i++) {
      const page = doc.loadPage(i)
      const px = page.toPixmap(mupdf.Matrix.scale(2.0, 2.0), mupdf.ColorSpace.DeviceRGB, false, true)
      const png = Buffer.from(px.asPNG())
      const qs = await visionExtract(png)
      for (const q of qs) {
        if (!q.number || !q.question || !q.options) continue
        if (t.miss.includes(q.number) && !found.has(q.number)) found.set(q.number, q)
      }
      await new Promise(r => setTimeout(r, 1000))
    }

    const existing = new Set(arr.filter(q => q.exam_code === t.code && q.subject === SUBJECT).map(q => q.number))
    let added = 0
    for (const [num, q] of found) {
      if (existing.has(num)) continue
      if (!q.options.A || !q.options.B || !q.options.C || !q.options.D) continue
      const ans = answers[num]
      if (!ans || ans === '#') { console.log(`    ${t.code} #${num}: no answer`); continue }
      maxId++
      arr.push({
        id: maxId,
        roc_year: t.year, session: t.sess, exam_code: t.code,
        subject: SUBJECT, subject_tag: TAG, subject_name: SUBJECT,
        stage_id: 0, number: num,
        question: q.question, options: q.options, answer: ans,
        explanation: '',
      })
      existing.add(num); added++
    }
    console.log(`  ${t.year}-${t.sess} 聽力學: +${added}/${t.miss.length} (found ${found.size}, ans ${Object.keys(answers).length})`)
    total += added
  }

  arr.sort((a, b) => {
    if (a.exam_code !== b.exam_code) return String(a.exam_code).localeCompare(String(b.exam_code))
    if (a.subject !== b.subject) return String(a.subject).localeCompare(String(b.subject))
    return (a.number || 0) - (b.number || 0)
  })
  fs.writeFileSync(fp, JSON.stringify(data, null, 2))
  console.log(`\nTOTAL +${total}`)
}

main().catch(e => { console.error(e); process.exit(1) })
