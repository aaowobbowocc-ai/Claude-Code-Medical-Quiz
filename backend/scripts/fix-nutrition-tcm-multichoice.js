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
  const m = q.question.match(/[?？]\s*([\s\S]+)$/)
  if (!m) return false
  const trailing = m[1].trim()
  if (trailing.length < 20) return false
  const optA = (q.options.A || '').slice(0, 30).replace(/\s+/g, '')
  const trH = trailing.slice(0, 30).replace(/\s+/g, '')
  if (optA.length < 10 || trH.length < 10) return false
  return optA.slice(0, 10) === trH.slice(0, 10) || trH.includes(optA.slice(0, 10))
}

const TARGETS = [
  // nutrition 109030 c=103
  { file: 'questions-nutrition.json', code: '109030', sMap: {
    '生理學與生物化學': '0201',
    '營養學': '0202',
    '膳食療養學': '0203',
    '團體膳食設計與管理': '0204',
    '公共衛生營養學': '0205',
    '食品衛生與安全': '0206',
  }, c: '103' },
  // tcm2 108110 c=101 only has tcm1 PDFs (0101/0102 = 中醫基礎一/二)
  // tcm2 (中醫臨床 一/二/三/四) needs different c - skip for now
  { file: 'questions-tcm2.json', code: '108110', sMap: {}, c: null },
  { file: 'questions-tcm2.json', code: '106030', sMap: {}, c: null },
]

async function main() {
  let totalFixed = 0
  for (const t of TARGETS) {
    if (!t.c) continue
    const fp = path.join(__dirname, '..', t.file)
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    const arr = data.questions || data
    const pdfs = {}
    for (const [subj, s] of Object.entries(t.sMap)) {
      const f = path.join(PDF_CACHE, `Q_${t.code}_c${t.c}_s${s}.pdf`)
      if (!fs.existsSync(f)) continue
      const buf = fs.readFileSync(f)
      pdfs[subj] = await readText(buf)
    }
    let fixed = 0
    for (const q of arr) {
      if (q.exam_code !== t.code) continue
      if (!isPolluted(q)) continue
      const pdfTxt = pdfs[q.subject]
      if (!pdfTxt) continue
      const parsed = parseFromPdf(pdfTxt, q.number)
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
      console.log(t.file, t.code, ':', fixed)
      totalFixed += fixed
    }
  }
  console.log('Total:', totalFixed)
}

main().catch(e => { console.error(e); process.exit(1) })
