#!/usr/bin/env node
// Probe subject codes and available sessions for 中醫師 (c=317/318) & 獸醫師 (c=314)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const https = require('https')
const pdfParse = require('pdf-parse')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

function fetch(code, c, s) {
  return new Promise((resolve, reject) => {
    const url = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
    https.get(url, {
      rejectUnauthorized: false, timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/pdf,*/*', 'Referer': 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) { res.resume(); return reject(new Error('302')) }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${res.statusCode}`)) }
      const ct = res.headers['content-type'] || ''
      if (!ct.includes('pdf') && !ct.includes('octet')) { res.resume(); return reject(new Error('not-pdf')) }
      const cs = []
      res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    }).on('error', reject)
  })
}

async function head(code, c, s) {
  try {
    const buf = await fetch(code, c, s)
    const t = (await pdfParse(buf)).text.slice(0, 500).replace(/\s+/g, ' ').trim()
    const year = (t.match(/(\d{3})年/) || [])[1] || ''
    const sess = (t.match(/第[一二三四五]次/) || [])[0] || ''
    const cls = (t.match(/類\s*科[：:]\s*([^\s]+)/) || [])[1] || ''
    const sub = (t.match(/科\s*目[：:]\s*(.+?)(?:\s{2,}|$)/) || [])[1] || ''
    const qCount = (t.match(/本科目共\s*(\d+)\s*題/) || [])[1] || ''
    return `${year}${sess} ${cls} | ${sub.slice(0,40)} | ${qCount}題`
  } catch (e) { return null }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  // Session code patterns to try. 醫師/醫檢/物治/中醫/獸醫 use various suffixes:
  // 020,030,040,070,080,090,100,101,120 etc.
  const SESSIONS = [
    '110020','110070','110080','110100','110101','110120',
    '111020','111070','111080','111090','111100','111120',
    '112020','112070','112080','112090','112100','112120',
    '113020','113070','113080','113090','113100','113120',
    '114020','114070','114080','114090','114100','114120',
    '115020','115070','115080','115090','115100','115120',
  ]
  const SUBJECTS = ['11','22','33','44','55','66']

  for (const [label, c] of [['獸醫師','314'], ['中醫師(一)','317'], ['中醫師(二)','318']]) {
    console.log(`\n=== ${label} c=${c} ===`)
    for (const code of SESSIONS) {
      const results = []
      for (const s of SUBJECTS) {
        const r = await head(code, c, s)
        if (r) results.push(`s=${s}: ${r}`)
        await sleep(100)
      }
      if (results.length) {
        console.log(`  ${code}:`)
        for (const r of results) console.log(`    ${r}`)
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
