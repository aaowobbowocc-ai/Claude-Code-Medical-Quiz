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
  // 找第一個 ? 結尾即視為題幹結束（不要求 ? 後立刻 newline，因 ?1statement... 連著常見）
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
  return {
    question,
    options: { A: optBlocks[0], B: optBlocks[1], C: optBlocks[2], D: optBlocks[3] },
  }
}

// 護理 5 卷 s code 對應 subject
const NURSING_S_MAP = {
  '基礎醫學': '0501',
  '基本護理學與護理行政': '0502',
  '內外科護理學': '0503',
  '產兒科護理學': '0504',
  '精神科與社區衛生護理學': '0505',
}

const TARGETS_C106 = ['107030','107110','108110','106110']

async function main() {
  const fp = path.join(__dirname, '..', 'questions-nursing.json')
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data

  // Load PDFs
  const pdfs = {}  // code|subject → text
  for (const code of TARGETS_C106) {
    for (const [subj, s] of Object.entries(NURSING_S_MAP)) {
      const f = path.join(PDF_CACHE, `Q_${code}_c106_s${s}.pdf`)
      if (!fs.existsSync(f)) continue
      const buf = fs.readFileSync(f)
      pdfs[`${code}|${subj}`] = await readText(buf)
    }
  }
  console.log('Loaded PDFs:', Object.keys(pdfs).length)

  let fixed = 0
  for (const q of arr) {
    if (!TARGETS_C106.includes(q.exam_code)) continue
    // Check if polluted
    if (!q.question || !q.options) continue
    const m = q.question.match(/[?？]\s*([\s\S]+)$/)
    if (!m || m[1].trim().length < 20) continue
    const optA = (q.options.A || '').slice(0, 30).replace(/\s+/g, '')
    const trH = m[1].slice(0, 30).replace(/\s+/g, '')
    if (optA.length < 10 || trH.length < 10) continue
    if (!(optA.slice(0,10) === trH.slice(0,10) || trH.includes(optA.slice(0,10)))) continue
    // Find PDF
    const pdfTxt = pdfs[q.exam_code + '|' + q.subject]
    if (!pdfTxt) continue
    const parsed = parseFromPdf(pdfTxt, q.number)
    if (!parsed) continue
    const optLens = Object.values(parsed.options).map(v => v.length)
    if (optLens.some(L => L > 250 || L < 1)) continue
    q.question = parsed.question
    q.options = parsed.options
    q.disputed = true
    fixed++
    if (fixed <= 3) {
      console.log(q.id, '#'+q.number, q.exam_code, q.subject)
      console.log('  Q:', parsed.question.slice(0, 80))
      console.log('  A:', parsed.options.A.slice(0, 50))
    }
  }
  fs.writeFileSync(fp, JSON.stringify(data, null, 2))
  console.log('\nFixed:', fixed)
}

main().catch(e => { console.error(e); process.exit(1) })
