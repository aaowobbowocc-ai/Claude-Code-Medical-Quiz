#!/usr/bin/env node
/**
 * Vision OCR fallback for 6 nursing questions parseColumnAware couldn't extract.
 */
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { GoogleAuth } = require('google-auth-library')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const BACKEND = path.resolve(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')
const VERTEX_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0502672630'
const VERTEX_REGION = 'us-central1'
// MODEL: gemini-2.5-flash (changed 2026-05-23 from gemini-2.5-pro)
//   OCR / Vision 任務不需要 Pro 推理；Flash 同準確度但便宜 ~17-33 倍。
//   5/22 batch 跑 Pro thinking 一次燒 $200+，Flash 同 batch 約 $5-10。
//   若特殊題目 Flash 結果不佳，再針對該批改回 'gemini-2.5-pro'。
const VERTEX_MODEL = 'gemini-2.5-flash'
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const TARGETS = [
  { file: 'questions-nursing.json', pdf: 'Q_102030_c110_s0604.pdf', ans: 'S_102030_c110_s0604.pdf',
    year: '102', sess: '第一次', code: '102030', subject: '精神科與社區衛生護理學', tag: 'psychiatric_nursing',
    nums: [47, 72] },
  { file: 'questions-nursing.json', pdf: 'nursing_101110_c109_s0601.pdf', ans: 'A_nursing_101110_c109_s0601.pdf',
    year: '101', sess: '第二次', code: '101110', subject: '基本護理學與護理行政', tag: 'fundamental_nursing',
    nums: [41] },
  { file: 'questions-nursing.json', pdf: 'nursing_101110_c109_s0603.pdf', ans: 'A_nursing_101110_c109_s0603.pdf',
    year: '101', sess: '第二次', code: '101110', subject: '產兒科護理學', tag: 'obstetric_nursing',
    nums: [72] },
  { file: 'questions-nursing.json', pdf: 'nursing_101110_c109_s0604.pdf', ans: 'A_nursing_101110_c109_s0604.pdf',
    year: '101', sess: '第二次', code: '101110', subject: '精神科與社區衛生護理學', tag: 'psychiatric_nursing',
    nums: [28] },
]

async function findAnswerPdf(t) {
  const candidates = [t.ans, t.ans.replace('A_', 'S_'), t.ans.replace('nursing_', 'A_'), t.ans.replace('A_nursing_', 'A_')]
  for (const c of candidates) {
    const p = path.join(PDF_CACHE, c)
    if (fs.existsSync(p)) return p
  }
  // Probe by prefix
  const prefix = t.pdf.replace(/^(Q_|nursing_)/, '').replace('.pdf', '')
  const matches = fs.readdirSync(PDF_CACHE).filter(f => f.includes(prefix) && (f.startsWith('A_') || f.startsWith('S_')))
  return matches.length ? path.join(PDF_CACHE, matches[0]) : null
}

async function parseAnswers(pdfPath) {
  if (!pdfPath || !fs.existsSync(pdfPath)) return {}
  const mupdf = await import('mupdf')
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
  // half-width fallback
  n = 1
  const hw = /答案\s*([A-D#]{10,})/gi
  while ((m = hw.exec(txt)) !== null) {
    for (const ch of m[1]) { if (/[A-D]/i.test(ch)) answers[n] = ch.toUpperCase(); n++ }
  }
  if (Object.keys(answers).length >= 20) return answers
  // single-letter scan (CBT answer keys like "1 A 2 B")
  n = 1; answers2 = {}
  const sl = /(\d{1,3})\s+([A-D])(?![A-Z])/g
  while ((m = sl.exec(txt)) !== null) {
    const num = parseInt(m[1]); if (num >= 1 && num <= 200) answers2[num] = m[2]
  }
  if (Object.keys(answers2).length >= 20) return answers2
  return answers
}

async function visionExtract(pngBuf, nums) {
  const tk = await auth.getAccessToken()
  const tokenStr = typeof tk === 'string' ? tk : tk.token
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`
  const prompt = `這是台灣國考試題 PDF 截圖。請只抽取題號 ${nums.join(', ')} 的題目，輸出 JSON 陣列：
[
  {"number": 數字, "question": "題目正文", "options": {"A":"...","B":"...","C":"...","D":"..."}}
]
規則：
- 四選一選擇題
- 題目完整、選項完整
- 只輸出 JSON，無其他文字
- 若該頁沒有指定題號，輸出 []`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenStr}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            { inlineData: { data: pngBuf.toString('base64'), mimeType: 'image/png' } },
            { text: prompt },
          ] }],
          generationConfig: { temperature: 0.0, maxOutputTokens: 4000, thinkingConfig: { thinkingBudget: 512 } },
        }),
      })
      if (resp.status === 429) { await new Promise(r => setTimeout(r, 3000 * 2 ** attempt)); continue }
      if (!resp.ok) { if (attempt === 2) return []; await new Promise(r => setTimeout(r, 2000)); continue }
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
  let total = 0
  for (const t of TARGETS) {
    const qPath = path.join(PDF_CACHE, t.pdf)
    if (!fs.existsSync(qPath)) { console.log(`✗ no Q PDF: ${t.pdf}`); continue }
    const aPath = await findAnswerPdf(t)
    const answers = await parseAnswers(aPath)
    console.log(`\n${t.year}-${t.sess} ${t.subject} | answers: ${Object.keys(answers).length} | need: ${t.nums.join(',')}`)

    const mupdf = await import('mupdf')
    const buf = fs.readFileSync(qPath)
    const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
    const found = new Map()
    for (let i = 0; i < doc.countPages() && found.size < t.nums.length; i++) {
      const page = doc.loadPage(i)
      const px = page.toPixmap(mupdf.Matrix.scale(2.0, 2.0), mupdf.ColorSpace.DeviceRGB, false, true)
      const png = Buffer.from(px.asPNG())
      const need = t.nums.filter(n => !found.has(n))
      if (!need.length) break
      const qs = await visionExtract(png, need)
      for (const q of qs) {
        if (!q.number || !q.question || !q.options) continue
        if (need.includes(q.number)) found.set(q.number, q)
      }
    }
    console.log(`  Vision found ${found.size}/${t.nums.length}`)

    const fp = path.join(BACKEND, t.file)
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    const arr = data.questions || data
    const existing = new Set(arr.filter(q => q.exam_code === t.code && q.subject === t.subject).map(q => q.number))
    const maxId = arr.reduce((m, q) => Math.max(m, parseInt(String(q.id).replace(/\D/g, '')) || 0), 0)
    let nextId = maxId + 1
    let added = 0
    for (const [num, q] of found) {
      if (existing.has(num)) continue
      const opts = q.options
      if (!opts.A || !opts.B || !opts.C || !opts.D) continue
      const ans = answers[num]
      if (!ans || ans === '#') { console.log(`    #${num}: no answer`); continue }
      arr.push({
        id: nextId++,
        roc_year: t.year, session: t.sess, exam_code: t.code,
        subject: t.subject, subject_tag: t.tag, subject_name: t.subject,
        stage_id: 0, number: num,
        question: q.question, options: opts, answer: ans,
        explanation: '',
      })
      existing.add(num); added++
    }
    arr.sort((a, b) => {
      if (a.exam_code !== b.exam_code) return String(a.exam_code).localeCompare(String(b.exam_code))
      if (a.subject !== b.subject) return String(a.subject).localeCompare(String(b.subject))
      return (a.number || 0) - (b.number || 0)
    })
    fs.writeFileSync(fp, JSON.stringify(data, null, 2))
    console.log(`  ✓ +${added}`)
    total += added
  }
  console.log(`\nTOTAL +${total}`)
}

main().catch(e => { console.error(e); process.exit(1) })
