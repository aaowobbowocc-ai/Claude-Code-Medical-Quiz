#!/usr/bin/env node
/**
 * Download missing PDFs for incomplete questions, then OCR.
 *
 * For each incomplete question, infers (c, s) from existing data of the same
 * exam by matching subject_tag → already-cached PDF naming pattern.
 */

require('dotenv/config')
const fs = require('fs')
const path = require('path')
const https = require('https')
const { GoogleAuth } = require('google-auth-library')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const BACKEND   = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')
const VERTEX_PROJECT = 'gen-lang-client-0502672630'
const VERTEX_REGION  = 'us-central1'
const VERTEX_MODEL   = 'gemini-2.5-pro'
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

const EXAM_FILES = {
  'social-worker':  'questions-social-worker.json',
  customs:          'questions-customs.json',
  judicial:         'questions-judicial.json',
  'civil-senior':   'questions-civil-senior.json',
  lawyer1:          'questions-lawyer1.json',
}

// Known (subject) → c/s patterns per exam, derived from existing cached PDFs
// + CLAUDE.md memory.
// codeSuffixes: alternative exam_code endings to try when stored exam_code
// doesn't match MoEX's actual file. e.g. civil-senior stored as 109090 but
// 法學知識與英文 lives at 109130 (shared with other 三等). Replace last 3 digits.
const PATTERNS = {
  'social-worker': {
    '社會工作':         { c: '107', s: '0601' },
    '社會工作直接服務':  { c: '107', s: '0602' },
    '社會工作管理':     { c: '107', s: '0603' },
  },
  customs: {
    // customs 法學知識+英文 為合併卷（一份 PDF 50 題：前 25 法學、後 25 英文），同 s
    // 已 probe: 108050→0307, 109050→0308, 110050→0308, 111050→0310, 112050→0308, 115040→0305
    '法學知識':       { c: '101', sCandidates: ['0305','0307','0308','0310','0309','0312','0313','0315','0306','0311'] },
    '英文':          { c: '101', sCandidates: ['0305','0307','0308','0310','0309','0312','0313','0315','0306','0311'] },
    '國文（測驗）':   { c: '101', sCandidates: ['0306','0307','0308','0309','0310','0311'] },
  },
  judicial: {
    '法學知識與英文': { c: '101', sCandidates: ['0309','0313','0315','0414','0415','0412'], codeSuffixes: ['130','120'] },
  },
  'civil-senior': {
    // 高考三等 法緒英文/國文/行政學/行政法 共用 130 場次卷 (與司法等共用)
    '法學知識與英文': { c: '101', sCandidates: ['0309','0313','0315','0414','0415','0412'], codeSuffixes: ['130','120'] },
    '國文（測驗）':   { c: '101', sCandidates: ['0308','0307','0306','0309'], codeSuffixes: ['130','120'] },
    '行政學':        { c: '101', sCandidates: ['0408','0409','0410','0411','0412','0307','0308'], codeSuffixes: ['130','120'] },
    '行政法':        { c: '101', sCandidates: ['0408','0409','0410','0411','0412','0306','0307'], codeSuffixes: ['130','120'] },
  },
  lawyer1: {
    '綜合法學（民法、民事訴訟法）': { c: '101', sCandidates: ['0101','0102'], codeSuffixes: ['130','120'] },
    '綜合法學（公司法、保險法、票據法、證券交易法、強制執行法、法學英文）':
      { c: '101', sCandidates: ['0103','0104'], codeSuffixes: ['130','120'] },
  },
}

function get(url) {
  return new Promise((res) => {
    const agent = new https.Agent({ rejectUnauthorized: false })
    https.get(url, { agent }, r => {
      if (r.statusCode !== 200) { r.destroy(); return res(null) }
      const ch = []
      r.on('data', c => ch.push(c))
      r.on('end', () => res(Buffer.concat(ch)))
    }).on('error', () => res(null))
  })
}

async function verifyPdf(buf, expectSubject) {
  try {
    const mupdf = await import('mupdf')
    const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
    const text = stripPUA(doc.loadPage(0).toStructuredText('preserve-whitespace').asText())
    const cleanSubj = expectSubject.replace(/[（(].*[）)]/g, '').trim()
    if (text.includes(cleanSubj) || text.includes(expectSubject)) return true
    // Combined paper aliases:
    //   '英文' (single) shares PDF with '法學知識' / '法學知識與英文'
    //   customs/civil-senior 有時把合併卷拆成兩個 subject 存在 JSON
    if (expectSubject === '英文' && /(法學知識|法學知識與英文)/.test(text)) return true
    if (expectSubject === '法學知識' && /(法學知識與英文)/.test(text)) return true
    return false
  } catch { return false }
}

async function findOrDownloadPdf(exam, exam_code, subject) {
  // 1. Already cached?
  const prefix = `${exam}_${exam_code}_`
  const cached = fs.readdirSync(PDF_CACHE).filter(f => f.startsWith(prefix) && f.endsWith('.pdf') && !f.startsWith('A_'))
  for (const f of cached) {
    const buf = fs.readFileSync(path.join(PDF_CACHE, f))
    if (buf.length < 5000) continue
    if (await verifyPdf(buf, subject)) return { buf, file: f }
  }
  // 2. Try patterns. Build candidate exam_codes (original + suffixed alternatives).
  const pat = PATTERNS[exam]?.[subject]
  if (!pat) return null
  const cs = pat.s ? [pat.s] : pat.sCandidates
  const codeCandidates = [exam_code]
  if (pat.codeSuffixes) {
    const yearPart = exam_code.slice(0, 3)
    for (const suf of pat.codeSuffixes) {
      const alt = yearPart + suf
      if (alt !== exam_code) codeCandidates.push(alt)
    }
  }
  for (const code of codeCandidates) {
    for (const s of cs) {
      const url = `${BASE}?t=Q&code=${code}&c=${pat.c}&s=${s}&q=1`
      const buf = await get(url)
      if (!buf || buf.length < 5000) continue
      if (await verifyPdf(buf, subject)) {
        const newFile = `${exam}_${code}_c${pat.c}_s${s}.pdf`
        fs.writeFileSync(path.join(PDF_CACHE, newFile), buf)
        console.log(`    ↓ downloaded ${newFile}`)
        return { buf, file: newFile }
      }
    }
  }
  return null
}

async function findQuestionPage(buf, qnum) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n = doc.countPages()
  for (let i = 0; i < n; i++) {
    const t = stripPUA(doc.loadPage(i).toStructuredText('preserve-whitespace').asText())
    if (new RegExp(`(?:^|\\n)\\s*${qnum}[.、．]`).test(t)) return { doc, idx: i }
    if (new RegExp(`(?:^|\\n)\\s*${qnum}\\s*\\n`).test(t))   return { doc, idx: i }
    if (new RegExp(`(?:^|\\n)\\s*${qnum}\\s{2,}[^\\d]`).test(t)) return { doc, idx: i }
  }
  return null
}

async function vision(pngB64, qnum) {
  const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`
  const token = await auth.getAccessToken()
  const prompt = `這是台灣國家考試試題掃描頁。請從圖片中抽出第 ${qnum} 題的完整題目和 4 個選項。
若雙欄版型，依「左上→左下→右上→右下」逐欄讀取。
只輸出純 JSON：{"number":${qnum},"question":"...","options":{"A":"...","B":"...","C":"...","D":"..."}}`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            { inlineData: { data: pngB64, mimeType: 'image/png' } },
            { text: prompt },
          ]}],
          generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
        }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(JSON.stringify(data).slice(0, 200))
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
      const m = text.match(/[\[{][\s\S]*[\]}]/)
      if (m) return JSON.parse(m[0])
    } catch (e) {
      if (attempt >= 1) throw e
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  return null
}

async function processExam(examId) {
  const file = EXAM_FILES[examId]
  const filePath = path.join(BACKEND, file)
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const arr = raw.questions || raw
  const incomplete = arr.filter(q => q.incomplete)
  if (!incomplete.length) return 0
  console.log(`\n=== ${examId} (${incomplete.length} incomplete) ===`)
  const mupdf = await import('mupdf')
  let patched = 0
  for (let i = 0; i < incomplete.length; i++) {
    const q = incomplete[i]
    process.stdout.write(`  [${i+1}/${incomplete.length}] Q${q.number} ${q.exam_code} ${q.subject}... `)
    const found = await findOrDownloadPdf(examId, q.exam_code, q.subject)
    if (!found) { console.log('no PDF'); continue }
    const pageInfo = await findQuestionPage(found.buf, q.number)
    if (!pageInfo) { console.log('page not found'); continue }
    const pixmap = pageInfo.doc.loadPage(pageInfo.idx).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true)
    const png = Buffer.from(pixmap.asPNG())
    let ocr
    try { ocr = await vision(png.toString('base64'), q.number) }
    catch (e) { console.log('OCR err'); continue }
    if (!ocr) { console.log('no OCR'); continue }
    let changed = false
    if (ocr.question && ocr.question.length > (q.question || '').length) { q.question = ocr.question; changed = true }
    if (ocr.options) {
      for (const k of ['A','B','C','D']) {
        const cur = q.options?.[k]
        const nv = ocr.options[k]
        if ((!cur || cur === k) && nv && nv !== '[圖]') { q.options[k] = nv; changed = true }
      }
    }
    if (changed) {
      const stillEmpty = Object.values(q.options || {}).filter(v => !v || v === '[圖]').length
      if (stillEmpty === 0 && (q.question || '').length >= 10) { delete q.incomplete; delete q.gap_reason }
      patched++
      console.log('✓')
    } else {
      console.log('no change')
    }
    if (patched > 0 && patched % 5 === 0) {
      const toSave = raw.questions ? raw : arr
      fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2))
    }
  }
  if (patched > 0) {
    const toSave = raw.questions ? raw : arr
    fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2))
    console.log(`  💾 ${file} (+${patched})`)
  }
  return patched
}

async function main() {
  const argExam = process.argv.find(a => a.startsWith('--exam='))?.slice(7)
  const exams = argExam ? argExam.split(',') : Object.keys(EXAM_FILES)
  let total = 0
  for (const e of exams) total += await processExam(e)
  console.log(`\n總計：${total}`)
}

main().catch(e => { console.error(e); process.exit(1) })
