#!/usr/bin/env node
// Probe 關務特考 英文 subject codes for all years 104-115.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const { fetchPdf } = require('./lib/pdf-fetcher')
const pdfParse = require('pdf-parse')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const CODES = { '104':'104050','105':'105050','106':'106050','107':'107050',
  '108':'108050','109':'109050','110':'110050','111':'111050','112':'112050',
  '113':'113040','114':'114040','115':'115040' }

async function main() {
  for (const [year, code] of Object.entries(CODES)) {
    let hit = null
    for (const s of ['0201','0202','0203','0204']) {
      try {
        const buf = await fetchPdf(`${BASE}?t=Q&code=${code}&c=101&s=${s}&q=1`)
        const { text } = await pdfParse(buf)
        const head = text.slice(0, 120).replace(/\s+/g, ' ')
        const isEng = /English|英文/.test(text.slice(0, 400)) || /\bthe\b/i.test(text.slice(200, 600))
        console.log(`  ${year} c=101 s=${s}: 200  eng=${isEng}  「${head.slice(0,70)}」`)
        if (!hit) hit = s
      } catch (e) {}
      await sleep(180)
    }
    if (!hit) console.log(`  ${year}: ✗ no 英文 code found`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
