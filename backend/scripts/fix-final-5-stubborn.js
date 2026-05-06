#!/usr/bin/env node
/**
 * Fix the 5 stubborn questions Vision OCR missed at default DPI:
 *   medlab 100140 臨床生理病理 Q44
 *   nutrition 106030 膳食療養 Q20
 *   vet 104090 公衛 Q63
 *   audiologist 110111 基礎聽力 Q5
 *   audiologist 111110 輔具 Q7
 *
 * Strategy: render at 3x DPI with multiple prompts, send 2 pages to Vision.
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

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }

const TARGETS = [
  { jsonFile: 'questions-medlab.json', examPrefix: 'medlab', examCode: '100140', subject: '臨床生理學與病理學', subject_tag: 'paper1', number: 44, paperCount: 80, rocYear: '100', session: '第二次' },
  { jsonFile: 'questions-nutrition.json', examPrefix: 'nutrition', examCode: '106030', subject: '膳食療養學', subject_tag: 'paper1', number: 20, paperCount: 40, rocYear: '106', session: '第一次' },
  { jsonFile: 'questions-vet.json', examPrefix: 'vet', examCode: '104090', subject: '獸醫公共衛生學', subject_tag: 'public_health', number: 63, paperCount: 80, rocYear: '104', session: '第二次' },
  { jsonFile: 'questions-audiologist.json', examPrefix: 'audiologist', examCode: '110111', subject: '基礎聽力科學', subject_tag: 'paper1', number: 5, paperCount: 50, rocYear: '110', session: '第二次' },
  { jsonFile: 'questions-audiologist.json', examPrefix: 'audiologist', examCode: '111110', subject: '聽覺輔具原理與實務學', subject_tag: 'paper4', number: 7, paperCount: 50, rocYear: '111', session: '第二次' },
]

const SUBJECT_ALIASES = {
  '微生物學與臨床微生物學': ['微生物學及臨床微生物學', '微生物學'],
  '臨床生理學與病理學': ['臨床生理學', '臨床病理學'],
}

async function readPdfText(p) {
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(p)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) txt += '\n' + doc.loadPage(i).toStructuredText('preserve-whitespace').asText()
  return stripPUA(txt)
}

async function discoverPdf(examPrefix, examCode, subjectName) {
  const variants = { 'speech-therapist': ['speech-therapist','speech'] }
  const prefixes = variants[examPrefix] || [examPrefix]
  let files = []
  for (const pfx of prefixes) {
    files = files.concat(fs.readdirSync(PDF_CACHE).filter(f =>
      f.startsWith(pfx + '_' + examCode + '_') && f.endsWith('.pdf')
      && !f.startsWith('A_') && !f.startsWith('TM_') && !f.startsWith('TS_')
      && !f.endsWith('_S.pdf')
    ))
  }
  const stem = subjectName.replace(/[（(].*$/, '').trim()
  const headPart = stem.split(/[與及]/)[0]
  const keywords = [subjectName, stem, headPart, ...(SUBJECT_ALIASES[subjectName] || [])]
  for (const f of files) {
    const p = path.join(PDF_CACHE, f)
    const txt = await readPdfText(p)
    if (keywords.some(k => k && txt.includes(k))) return p
  }
  return null
}

async function findQuestionPage(pdfPath, qnum) {
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  for (let i = 0; i < doc.countPages(); i++) {
    const t = stripPUA(doc.loadPage(i).toStructuredText('preserve-whitespace').asText())
    if (new RegExp(`(?:^|\\n)\\s*${qnum}[.、．]`).test(t)) return { doc, idx: i }
    if (new RegExp(`(?:^|\\n)\\s*${qnum}\\s*\\n`).test(t))   return { doc, idx: i }
  }
  return null
}

async function pageToPng(doc, idx, scale) {
  const mupdf = await getMupdf()
  const page = doc.loadPage(idx)
  const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true)
  return Buffer.from(pixmap.asPNG())
}

async function visionExtractMulti(pngBufs, qnum, subject) {
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`
  const tk = await auth.getAccessToken()
  const tokenStr = (typeof tk === 'string') ? tk : tk.token
  const prompt = `這些是台灣國家考試「${subject}」試題掃描頁。請仔細看圖中的第 ${qnum} 題。
題號可能是「${qnum}.」或「${qnum} 」或單獨「${qnum}」一行。
雙欄版型則依「左上→左下→右上→右下」逐欄讀取選項位置以正確對應 A/B/C/D。
若仍找不到第 ${qnum} 題，回傳 {"found": false, "reason": "..."}。
只輸出純 JSON：{"found": true, "number": ${qnum}, "question": "完整題幹", "options": {"A": "...", "B": "...", "C": "...", "D": "..."}}`
  const parts = pngBufs.map(buf => ({ inlineData: { data: buf.toString('base64'), mimeType: 'image/png' } }))
  parts.push({ text: prompt })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenStr}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
        }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(JSON.stringify(data).slice(0, 300))
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
      const m = text.match(/\{[\s\S]*\}/)
      if (m) return JSON.parse(m[0])
    } catch (e) {
      console.log('     err:', e.message.slice(0, 200))
      if (attempt >= 1) return null
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  return null
}

async function getAnswer(examCode, c, s, qnum) {
  const candidates = [`TS_${examCode}_c${c}_s${s}.pdf`, `TM_${examCode}_c${c}_s${s}.pdf`]
  for (const fn of candidates) {
    const p = path.join(PDF_CACHE, fn)
    if (fs.existsSync(p)) {
      const txt = await readPdfText(p)
      const letters = (txt.match(/(?<![A-Z0-9])[A-D#](?![A-Z0-9])/g) || [])
      if (letters.length >= qnum) return letters[qnum - 1]
    }
  }
  return null
}

async function fixOne(t) {
  console.log(`\n=== ${t.examPrefix} ${t.examCode} ${t.subject} Q${t.number} ===`)
  const pdfPath = await discoverPdf(t.examPrefix, t.examCode, t.subject)
  if (!pdfPath) { console.log('  ✗ no PDF'); return false }
  const fname = path.basename(pdfPath)
  const csMatch = fname.match(/_c(\w+)_s(\w+?)(?:_Q)?\.pdf$/)
  if (!csMatch) { console.log('  ✗ no c/s'); return false }
  const [, c, s] = csMatch
  const pageInfo = await findQuestionPage(pdfPath, t.number)
  if (!pageInfo) { console.log('  ✗ no page'); return false }
  // Render the question page + next page (cross-page coverage), at high DPI
  const pages = [pageInfo.idx]
  if (pageInfo.idx + 1 < pageInfo.doc.countPages()) pages.push(pageInfo.idx + 1)
  console.log(`  found on page ${pageInfo.idx + 1}/${pageInfo.doc.countPages()}, sending 3x DPI`)
  const pngs = []
  for (const p of pages) pngs.push(await pageToPng(pageInfo.doc, p, 3))
  const v = await visionExtractMulti(pngs, t.number, t.subject)
  if (!v || !v.found) { console.log('  ✗ vision miss:', v?.reason || 'unknown'); return false }
  if (!v.options || Object.keys(v.options).length !== 4) { console.log('  ✗ incomplete options'); return false }
  if (Object.values(v.options).some(x => !x || x.length < 2)) { console.log('  ✗ empty option'); return false }
  const ans = await getAnswer(t.examCode, c, s, t.number)
  if (!ans || ans === '#') { console.log('  ✗ no answer'); return false }

  const filePath = path.join(BACKEND, t.jsonFile)
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const arr = data.questions || data
  const exists = arr.find(q => q.exam_code === t.examCode && q.subject === t.subject && q.number === t.number)
  if (exists) { console.log('  ✗ already exists'); return false }
  const maxId = arr.reduce((m, q) => Math.max(m, typeof q.id === 'number' ? q.id : parseInt(String(q.id).replace(/\D/g, '')) || 0), 0)
  arr.push({
    id: maxId + 1,
    roc_year: t.rocYear, session: t.session, exam_code: t.examCode,
    subject: t.subject, subject_tag: t.subject_tag, subject_name: t.subject,
    stage_id: 0, number: t.number, question: v.question, options: v.options, answer: ans, explanation: '',
  })
  arr.sort((a, b) => {
    if (a.exam_code !== b.exam_code) return a.exam_code.localeCompare(b.exam_code)
    if (a.subject !== b.subject) return a.subject.localeCompare(b.subject)
    return (a.number || 0) - (b.number || 0)
  })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
  console.log(`  ✓ added Q${t.number} (answer=${ans})`)
  return true
}

;(async () => {
  let n = 0
  for (const t of TARGETS) {
    if (await fixOne(t)) n++
  }
  console.log(`\n=== Done: ${n}/${TARGETS.length} ===`)
})().catch(e => { console.error(e); process.exit(1) })
