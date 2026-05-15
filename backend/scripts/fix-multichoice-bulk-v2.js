#!/usr/bin/env node
// 通用多選題污染修：loose parser (不要求 ? 後 \n+)，對每個 polluted q
// 掃 cache 所有 exam_code 相符的 PDF 嘗試 parse
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

function parseFromPdf(txt, num) {
  const re = new RegExp(`\\n\\s*${num}[\\.\\s]([\\s\\S]+?)\\n\\s*${num + 1}[\\.\\s]`)
  const m = txt.match(re)
  if (!m) return null
  const body = m[1].trim()
  const qm = body.match(/^([\s\S]+?[?？])/)
  if (!qm) return null
  let question = qm[1].replace(/\s+/g, ' ').trim()
  const rest = body.slice(qm[0].length)
  const allBlocks = rest.split(/\n+/).map(s => s.trim()).filter(s => s.length > 0 && !/^代號|^頁次/.test(s))
  if (allBlocks.length < 4) return null
  const hasMultiStatements = /[①②③④⑤]/.test(body) || /\s[1-7][^\d]/.test(body)
  let optBlocks
  if (hasMultiStatements && allBlocks.length > 4) {
    optBlocks = allBlocks.slice(-4)
    const statements = allBlocks.slice(0, -4)
    if (statements.length > 0) question = (question + ' ' + statements.join(' ')).replace(/\s+/g, ' ').trim()
  } else {
    optBlocks = allBlocks.slice(0, 4)
  }
  return { question, options: { A: optBlocks[0], B: optBlocks[1], C: optBlocks[2], D: optBlocks[3] } }
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

const FILES = [
  'questions.json','questions-doctor2.json','questions-dental1.json','questions-dental2.json',
  'questions-pharma1.json','questions-pharma2.json','questions-tcm1.json','questions-tcm2.json',
  'questions-nursing.json','questions-nutrition.json','questions-medlab.json','questions-pt.json',
  'questions-ot.json','questions-radiology.json','questions-vet.json','questions-social-worker.json',
  'questions-audiologist.json','questions-speech-therapist.json','questions-rt.json',
]

async function main() {
  // Build code → PDF list
  const allFiles = fs.readdirSync(PDF_CACHE).filter(f => f.endsWith('.pdf') &&
    !f.startsWith('A_') && !f.startsWith('M_') && !f.startsWith('S_') && !f.startsWith('T'))
  const codePdfs = {}
  for (const f of allFiles) {
    const m = f.match(/_(\d{5,6})_c\w+_s\w+/)
    if (!m) continue
    if (!codePdfs[m[1]]) codePdfs[m[1]] = []
    codePdfs[m[1]].push(f)
  }
  console.log('Codes:', Object.keys(codePdfs).length)

  // Cache parsed PDFs (lazy)
  const pdfTextCache = {}
  async function getText(f) {
    if (pdfTextCache[f] !== undefined) return pdfTextCache[f]
    try {
      const buf = fs.readFileSync(path.join(PDF_CACHE, f))
      const txt = await readText(buf)
      pdfTextCache[f] = txt
      return txt
    } catch { pdfTextCache[f] = null; return null }
  }

  let total = 0
  for (const fp of FILES) {
    if (!fs.existsSync(fp)) continue
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    const arr = data.questions || data
    let fixed = 0
    for (const q of arr) {
      if (!isPolluted(q)) continue
      const pdfList = codePdfs[q.exam_code]
      if (!pdfList) continue
      // Try each PDF in this code, prefer match by subject in filename hash or just try all
      let parsed = null
      for (const f of pdfList) {
        const txt = await getText(f)
        if (!txt) continue
        const p = parseFromPdf(txt, q.number)
        if (!p) continue
        // Validate: parsed.question's first 10 chars should match current q.question prefix
        const qPrefix = q.question.slice(0, 15).replace(/\s+/g, '')
        const pPrefix = p.question.slice(0, 15).replace(/\s+/g, '')
        if (qPrefix.length < 5 || pPrefix.length < 5) continue
        if (!qPrefix.includes(pPrefix.slice(0, 8)) && !pPrefix.includes(qPrefix.slice(0, 8))) continue
        parsed = p
        break
      }
      if (!parsed) continue
      const optLens = Object.values(parsed.options).map(v => v.length)
      if (optLens.some(L => L > 250 || L < 1)) continue
      q.question = parsed.question
      q.options = parsed.options
      q.disputed = true
      fixed++
    }
    if (fixed > 0) {
      fs.writeFileSync(fp, JSON.stringify(data, null, 2))
      console.log(fp, ':', fixed)
      total += fixed
    }
  }
  console.log('TOTAL:', total)
}

main().catch(e => { console.error(e); process.exit(1) })
