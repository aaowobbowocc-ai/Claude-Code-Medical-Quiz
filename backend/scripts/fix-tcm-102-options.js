#!/usr/bin/env node
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

// tcm1 102110 卷別 subject_tag → PDF s code
const TCM1_S_MAP = {
  '中醫基礎醫學(一)': '0201',  // 範疇粗略
  '中醫基礎醫學(二)': '0202',
}
const TCM2_S_MAP = {
  '中醫臨床醫學(一)': '0203',
  '中醫臨床醫學(二)': '0204',
  '中醫臨床醫學(三)': '0205',
  '中醫臨床醫學(四)': '0206',
}

async function main() {
  // Load all candidate PDFs
  const candidates = ['Q_102110_c103_s0201.pdf','Q_102110_c103_s0203.pdf','Q_102110_c103_s0204.pdf','Q_102110_c103_s0205.pdf',
                       'Q_102110_c104_s0201.pdf','Q_102110_c105_s0203.pdf','Q_102110_c105_s0204.pdf','Q_102110_c105_s0205.pdf']
  const pdfs = {}
  for (const f of candidates) {
    const fp = path.join(PDF_CACHE, f)
    if (!fs.existsSync(fp)) continue
    const buf = fs.readFileSync(fp)
    const txt = await readText(buf)
    const m = f.match(/_s(\d+)\.pdf$/)
    const s = m[1]
    pdfs[s] = (pdfs[s] || []).concat([{ file: f, txt }])
  }
  console.log('Loaded s codes:', Object.keys(pdfs))

  for (const [fp, sMap] of [['questions-tcm1.json', TCM1_S_MAP], ['questions-tcm2.json', TCM2_S_MAP]]) {
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    const arr = data.questions || data
    let fixed = 0
    for (const q of arr) {
      if (q.exam_code !== '102110') continue
      // Try to get s code from id (102110_{s}_{n}) or fall back to subject
      let s = null
      const m = String(q.id).match(/^102110_(\d{4})_(\d+)$/)
      if (m) { s = m[1] }
      else if (q.subject && sMap[q.subject]) s = sMap[q.subject]
      else continue
      const pdfList = pdfs[s]
      if (!pdfList) continue
      // Try each PDF (both c=103 and c=105 may have same s)
      let parsed = null
      for (const pdf of pdfList) {
        parsed = parseFromPdf(pdf.txt, q.number)
        if (parsed) break
      }
      if (!parsed) continue
      const optLens = Object.values(parsed.options).map(v => v.length)
      if (optLens.some(L => L > 200 || L < 1)) continue
      // Only update if current options look broken (very short or trailing in question)
      const optAShort = (q.options?.A || '').length < 3
      const trailing = q.question?.match(/[?？]\s*([\s\S]{30,})/)
      if (!optAShort && !trailing) continue
      q.question = parsed.question
      q.options = parsed.options
      q.disputed = true
      fixed++
    }
    fs.writeFileSync(fp, JSON.stringify(data, null, 2))
    console.log(fp + ': fixed', fixed)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
