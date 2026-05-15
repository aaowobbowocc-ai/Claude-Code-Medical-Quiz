#!/usr/bin/env node
/**
 * 對 nursing.json 各 exam_code，從 cache 找對應 PDF (含 nursing_ 前綴或 Q_ 前綴)
 * 驗證 PDF 第一題 vs DB 第一題（針對每卷）
 */
const fs = require('fs')
const path = require('path')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')

const TARGETS = ['100030','100140','101030','101110','103030','103100','104030','104100','105030','105090','106030','106110','107030','107110','108020','108110','109030','109110','110030','110110','111030','111110','112030','112110','112110','113030','113100','114030','114100','115030']

async function readHead(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  return doc.loadPage(0).toStructuredText('preserve-whitespace').asText().slice(0, 800).normalize('NFKC')
}

async function readQ1(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) txt += doc.loadPage(i).toStructuredText('preserve-whitespace').asText()
  const norm = txt.normalize('NFKC')
  const m = norm.match(/\n\s*1\.\s*([^\n]{10,150})/) || norm.match(/\n\s*1\s+([^\n]{20,150})/)
  return m?.[1]?.slice(0, 60) || null
}

function normalize(s) {
  if (!s) return ''
  return s.replace(/\s+/g, '').replace(/[（(]/g,'(').replace(/[）)]/g,')').replace(/[，,]/g,',').replace(/[：:]/g,':').replace(/[？?]/g,'?').slice(0, 30)
}

async function main() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'questions-nursing.json'), 'utf-8'))
  const arr = data.questions || data
  const codes = [...new Set(arr.map(q => q.exam_code))].sort()
  const files = fs.readdirSync(PDF_CACHE)
  const polluted = []
  const clean = []

  for (const code of codes) {
    // Find candidate nursing PDFs for this code
    const candidates = files.filter(f =>
      f.includes('_' + code + '_') &&
      !f.startsWith('A_') && !f.startsWith('M_') && !f.startsWith('TA_') && !f.startsWith('TS_') && !f.startsWith('TM_')
      && !f.endsWith('_A.pdf') && !f.endsWith('_M.pdf') && !f.endsWith('_S.pdf')
    )
    let nursingFile = null
    for (const f of candidates) {
      try {
        const buf = fs.readFileSync(path.join(PDF_CACHE, f))
        const head = await readHead(buf)
        if (head.includes('護理師') && head.includes('類')) { nursingFile = f; break }
      } catch {}
    }
    if (!nursingFile) {
      console.log(code, ': no nursing PDF in cache')
      continue
    }

    // Read PDF Q1
    const buf = fs.readFileSync(path.join(PDF_CACHE, nursingFile))
    const pdfQ1 = await readQ1(buf)
    const head = await readHead(buf)
    const pdfSubject = head.match(/科\s*目[：:]?\s*([^\n]+)/)?.[1]?.slice(0,40)

    // Find matching DB question (Q1 for the same subject)
    // First map subject by includes
    const subjects = [...new Set(arr.filter(q => q.exam_code === code).map(q => q.subject))]
    let bestSubject = null
    for (const s of subjects) {
      if (pdfSubject?.includes(s.slice(0, 4)) || s.includes(pdfSubject?.slice(0, 4))) {
        bestSubject = s; break
      }
    }
    const dbQ1 = arr.find(q => q.exam_code === code && q.subject === bestSubject && q.number === 1)?.question?.slice(0, 60)

    const npdf = normalize(pdfQ1)
    const ndb = normalize(dbQ1)
    const match = npdf && ndb && (npdf.includes(ndb.slice(0,20)) || ndb.includes(npdf.slice(0,20)))

    console.log(`${code} [${pdfSubject?.slice(0,15)}] (vs DB ${bestSubject?.slice(0,15)}): ${match ? '✓' : '✗'}`)
    console.log(`   PDF: ${pdfQ1}`)
    console.log(`   DB:  ${dbQ1}`)
    if (!match) polluted.push({ code, pdfQ1, dbQ1, pdfSubject, bestSubject, nursingFile })
    else clean.push(code)
  }

  console.log('\n=== Summary ===')
  console.log('Clean:', clean.length, ':', clean.join(','))
  console.log('Polluted/Suspect:', polluted.length)
  for (const p of polluted) console.log(' ', p.code, '|', p.pdfSubject, '|', p.bestSubject, '| pdf:', p.pdfQ1?.slice(0,30), '| db:', p.dbQ1?.slice(0,30))
  fs.writeFileSync(path.join(__dirname, '..', '_tmp', 'nursing-verify.json'), JSON.stringify({clean, polluted}, null, 2))
}

main().catch(e => { console.error(e); process.exit(1) })
