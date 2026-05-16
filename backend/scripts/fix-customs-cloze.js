#!/usr/bin/env node
// Fill customs 107050 英文 cloze/reading questions. Each "請依下文回答第X題
// 至第Y題" block has a shared passage; questions X..Y get that passage as the
// stem. Also fills standalone vocab cloze (single-sentence with a blank).
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

async function main() {
  const APPLY = process.argv.includes('--apply')
  const txt = await readText(fs.readFileSync(path.join(PDF_CACHE, 'customs_107050_c101_s0202.pdf')))
  // 測驗題 section
  const tIdx = txt.search(/乙、測驗題/)
  const body = tIdx >= 0 ? txt.slice(tIdx) : txt

  // Map question number → stem text
  const stems = {}
  // 1) Passage blocks: 請依下文回答第X題至第Y題 \n <passage> \n X \n
  const passRe = /請依下文回答第\s*(\d+)\s*題至第\s*(\d+)\s*題\s*([\s\S]+?)(?=\n\s*\d+\s*\n)/g
  let pm
  while ((pm = passRe.exec(body)) !== null) {
    const start = parseInt(pm[1]), end = parseInt(pm[2])
    const passage = pm[3].replace(/\s+/g, ' ').trim()
    if (passage.length < 20) continue
    for (let n = start; n <= end; n++) {
      stems[n] = `（閱讀測驗）${passage}\n\n第 ${n} 題：選出最適合的答案`
    }
  }
  // 2) Standalone vocab cloze: "N\n<sentence with blank>\n<optA>..."
  // sentence line is the one right after the number, before 4 short option lines
  const lines = body.split(/\n+/).map(s => s.trim())
  for (let i = 0; i < lines.length; i++) {
    if (!/^\d{1,2}$/.test(lines[i])) continue
    const n = parseInt(lines[i])
    if (stems[n]) continue
    // gather sentence lines until we hit 4 short option lines
    const sent = []
    let j = i + 1
    while (j < lines.length && sent.join('').length < 400) {
      // peek: are next 4 lines short (options)?
      const next4 = lines.slice(j, j + 4)
      const looksOpt = next4.length === 4 && next4.every(l => l && l.length < 40 && !/[._]{2,}/.test(l))
      if (looksOpt && sent.length > 0) break
      sent.push(lines[j]); j++
      if (sent.length > 6) break
    }
    const sentence = sent.join(' ').replace(/\s+/g, ' ').trim()
    if (sentence.length > 20 && /_|＿|\(\s*\)/.test(sentence)) stems[n] = sentence
  }

  const data = JSON.parse(fs.readFileSync('questions-customs.json', 'utf-8'))
  const arr = data.questions || data
  let fixed = 0
  for (const q of arr) {
    if (q.exam_code !== '107050' || q.subject !== '英文') continue
    if (q.incomplete !== 'empty_question' && (q.question && q.question.length >= 5)) continue
    const stem = stems[q.number]
    if (!stem) continue
    if (APPLY) { q.question = stem; delete q.incomplete }
    fixed++
    if (fixed <= 3) console.log(`  #${q.number}: ${stem.slice(0, 70)}...`)
  }
  if (APPLY) fs.writeFileSync('questions-customs.json', JSON.stringify(data, null, 2))
  console.log('fixed:', fixed, APPLY ? '(applied)' : '(dry-run)')
}
main().catch(e => { console.error(e); process.exit(1) })
