#!/usr/bin/env node
/**
 * 通用批次修：題幹混入選項殘片
 * 預先掃 cache 所有 PDF 建立 (exam_code, subject) → PDF map
 * 對每個 suspect 找 PDF 重抽 question + 4 options
 */
const fs = require('fs')
const path = require('path')

const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }
async function readText(buf) {
  const mupdf = await getMupdf()
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) txt += doc.loadPage(i).toStructuredText('preserve-whitespace').asText()
  return txt.normalize('NFKC')
}

// Pre-build (code, subject_prefix) → text
async function buildPdfMap() {
  const map = {}  // code → [{ subject, txt }]
  const files = fs.readdirSync(PDF_CACHE).filter(f => f.endsWith('.pdf') &&
    !f.startsWith('A_') && !f.startsWith('M_') && !f.startsWith('S_') && !f.startsWith('T'))
  for (const f of files) {
    const m = f.match(/_(\d{5,6})_c\w+_s\w+/)
    if (!m) continue
    const code = m[1]
    try {
      const buf = fs.readFileSync(path.join(PDF_CACHE, f))
      const txt = await readText(buf)
      const head = txt.slice(0, 500)
      const sub = head.match(/科\s*目[：:]?\s*([^\n]+)/)?.[1]?.trim()
      if (!sub) continue
      if (!map[code]) map[code] = []
      map[code].push({ subject: sub, file: f, txt })
    } catch {}
  }
  return map
}

function parseFromPdf(txt, num) {
  const re = new RegExp(`\\n\\s*${num}[\\.\\s]([\\s\\S]+?)\\n\\s*${num + 1}[\\.\\s]`)
  const m = txt.match(re)
  if (!m) return null
  const body = m[1].trim()
  const qm = body.match(/^([\s\S]+?[?？])\s*\n+/)
  if (!qm) return null
  const question = qm[1].replace(/\s+/g, ' ').trim()
  const rest = body.slice(qm[0].length)
  const optBlocks = rest.split(/\n+/).map(s => s.trim()).filter(s => s.length > 0 && !/^代號|^頁次|^\d+\s*$/.test(s))
  if (optBlocks.length < 4) return null
  return {
    question,
    options: { A: optBlocks[0], B: optBlocks[1], C: optBlocks[2], D: optBlocks[3] },
  }
}

const FILES = {
  'questions-nursing.json': 'nursing',
  'questions-nutrition.json': 'nutrition',
  'questions-tcm1.json': 'tcm1',
  'questions-tcm2.json': 'tcm2',
  'questions-doctor2.json': 'doctor2',
  'questions-ot.json': 'ot',
  'questions-pt.json': 'pt',
  'questions-rt.json': 'rt',
  'questions-radiology.json': 'radiology',
  'questions-medlab.json': 'medlab',
  'questions-dental2.json': 'dental2',
  'questions-pharma2.json': 'pharma2',
  'questions-social-worker.json': 'social-worker',
  'questions-vet.json': 'vet',
  'questions-audiologist.json': 'audiologist',
  'questions-speech-therapist.json': 'speech-therapist',
  'questions.json': 'doctor1',
}

function isPolluted(q) {
  if (!q.question || !q.options) return false
  if (q.subject && /英文|英語/.test(q.subject)) return false
  const m = q.question.match(/[?？]\s*([\s\S]+)$/)
  if (!m) return false
  const trailing = m[1].trim()
  if (trailing.length < 20) return false
  const optA = (q.options.A || '').slice(0, 30).replace(/\s+/g, '')
  const trH = trailing.slice(0, 30).replace(/\s+/g, '')
  if (optA.length < 10 || trH.length < 10) return false
  return optA.slice(0, 10) === trH.slice(0, 10) || trH.includes(optA.slice(0, 10))
}

async function main() {
  console.log('Building PDF map...')
  const pdfMap = await buildPdfMap()
  console.log('Codes with PDFs:', Object.keys(pdfMap).length)

  let totalFixed = 0
  for (const [fp, prefix] of Object.entries(FILES)) {
    if (!fs.existsSync(fp)) continue
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    const arr = data.questions || data
    let fileFixed = 0
    for (const q of arr) {
      if (!isPolluted(q)) continue
      const pdfs = pdfMap[q.exam_code]
      if (!pdfs) continue
      // Find PDF matching subject
      const subj = q.subject || ''
      const subjShort = subj.slice(0, 4)
      let parsed = null
      for (const pdf of pdfs) {
        if (!pdf.subject.includes(subjShort) && !subj.includes(pdf.subject.slice(0, 4))) continue
        parsed = parseFromPdf(pdf.txt, q.number)
        if (parsed) break
      }
      if (!parsed) continue
      const optLens = Object.values(parsed.options).map(v => v.length)
      if (optLens.some(L => L > 250 || L < 1)) continue
      q.question = parsed.question
      q.options = parsed.options
      q.disputed = true
      fileFixed++
    }
    if (fileFixed > 0) {
      fs.writeFileSync(fp, JSON.stringify(data, null, 2))
      console.log(fp, ':', fileFixed)
      totalFixed += fileFixed
    }
  }
  console.log('\nTOTAL fixed:', totalFixed)
}

main().catch(e => { console.error(e); process.exit(1) })
