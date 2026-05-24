#!/usr/bin/env node
// Probe 關務特考 106/107 法學知識 + 英文 subject codes,
// and test parseColumnAware output quality on a known-year PDF.
// Usage: node scripts/probe-customs.js

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const { fetchPdf } = require('./lib/pdf-fetcher')
const { parseColumnAware } = require('./lib/moex-column-parser')
const pdfParse = require('pdf-parse')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function probeYear(code, year) {
  console.log(`\n═══ ${year} (${code}) ═══`)
  // 法學知識: try s codes 0305..0314 (c=101)
  for (const s of ['0305','0306','0307','0308','0309','0310','0311','0312','0313','0314']) {
    try {
      const buf = await fetchPdf(`${BASE}?t=Q&code=${code}&c=101&s=${s}&q=1`)
      const { text } = await pdfParse(buf)
      const head = text.slice(0, 160).replace(/\s+/g, ' ')
      console.log(`  c=101 s=${s}: HTTP200  「${head.slice(0, 90)}」`)
    } catch (e) {
      // 302/not-found → skip silently unless it's a different error
    }
    await sleep(200)
  }
}

async function testParse() {
  console.log('\n═══ parseColumnAware test: 110 法學知識 (110050 c=101 s=0308) ═══')
  const buf = await fetchPdf(`${BASE}?t=Q&code=110050&c=101&s=0308&q=1`)
  const parsed = await parseColumnAware(buf)
  const nums = Object.keys(parsed).map(Number).sort((a, b) => a - b)
  console.log(`  parsed ${nums.length} questions: ${nums.join(',')}`)
  for (const n of [1, 2, 25]) {
    const q = parsed[n]
    if (!q) { console.log(`  Q${n}: (missing)`); continue }
    console.log(`  Q${n}: ${q.question.slice(0, 70)}`)
    for (const k of ['A','B','C','D']) console.log(`     ${k}: ${(q.options[k]||'').slice(0,60)}`)
  }
}

async function main() {
  await probeYear('106050', '106')
  await probeYear('107050', '107')
  await testParse()
}
main().catch(e => { console.error(e); process.exit(1) })
