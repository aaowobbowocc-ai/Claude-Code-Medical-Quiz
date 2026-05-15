#!/usr/bin/env node
/**
 * 修 doctor2 102-2 全部 320 題：從 PDF 重抓 question + 4 options
 * 保留 ans 不變
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

// 102110 doctor2 PDF 是 c=102 s=0103-0106 (醫學 三/四/五/六)
// PDF 內題目格式：N\n題幹...?\n選項A\n選項B\n選項C\n選項D\n(N+1)
function parseFromPdf(txt, num) {
  // Find Q num start + next Q
  const re = new RegExp(`\\n\\s*${num}[\\.\\s]([\\s\\S]+?)\\n\\s*${num + 1}[\\.\\s]`)
  const m = txt.match(re)
  if (!m) return null
  const body = m[1].trim()
  // Find question end
  const qm = body.match(/^([\s\S]+?[?？])\s*\n+/)
  if (!qm) return null
  const question = qm[1].replace(/\s+/g, ' ').trim()
  const rest = body.slice(qm[0].length)
  // Split options by blank line / multi-newline
  const optBlocks = rest.split(/\n+/).map(s => s.trim()).filter(s => s.length > 0 && !/^代號|^頁次|^\d+\s*$/.test(s))
  if (optBlocks.length < 4) return null
  return {
    question,
    options: {
      A: optBlocks[0],
      B: optBlocks[1],
      C: optBlocks[2],
      D: optBlocks[3],
    },
  }
}

async function main() {
  const fp = path.join(__dirname, '..', 'questions-doctor2.json')
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data

  // Load 4 PDFs
  const pdfs = {}
  for (const s of ['0103','0104','0105','0106']) {
    const buf = fs.readFileSync(path.join(PDF_CACHE, `Q_102110_c102_s${s}.pdf`))
    pdfs[s] = await readText(buf)
  }
  console.log('PDFs loaded')

  let fixed = 0
  let skipped = 0
  for (const q of arr) {
    if (q.exam_code !== '102110') continue
    // Match id pattern 102110_{ssss}_{num}
    const m = String(q.id).match(/^102110_(\d{4})_(\d+)$/)
    if (!m) continue
    const ss = m[1], num = parseInt(m[2])
    if (!pdfs[ss]) continue
    const parsed = parseFromPdf(pdfs[ss], num)
    if (!parsed) { skipped++; continue }
    // Update only if there's a real change & options look reasonable
    const optLens = Object.values(parsed.options).map(v => v.length)
    if (optLens.some(L => L > 200 || L < 1)) { skipped++; continue }
    // Avoid update if question + options are already correct
    const sameQ = q.question.replace(/\s+/g, '') === parsed.question.replace(/\s+/g, '')
    const sameOpts = ['A','B','C','D'].every(k => (q.options[k] || '').replace(/\s+/g, '') === parsed.options[k].replace(/\s+/g, ''))
    if (sameQ && sameOpts) continue
    q.question = parsed.question
    q.options = parsed.options
    q.disputed = true
    fixed++
    if (fixed <= 5) {
      console.log(q.id, '#'+num)
      console.log('  Q:', parsed.question.slice(0, 80))
      console.log('  A:', parsed.options.A.slice(0, 50))
    }
  }
  fs.writeFileSync(fp, JSON.stringify(data, null, 2))
  console.log(`\nFixed ${fixed} / Skipped ${skipped}`)
}

main().catch(e => { console.error(e); process.exit(1) })
