#!/usr/bin/env node
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const https = require('https')
const pdfParse = require('pdf-parse')
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

function fetch(code, c, s, t='Q') {
  return new Promise((resolve, reject) => {
    https.get(`${BASE}?t=${t}&code=${code}&c=${c}&s=${s}&q=1`, {
      rejectUnauthorized: false, timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/pdf,*/*', 'Referer': 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${res.statusCode}`)) }
      const cs = []; res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    }).on('error', reject)
  })
}

async function head(code, c, s) {
  try {
    const buf = await fetch(code, c, s)
    const text = (await pdfParse(buf)).text
    const first1k = text.slice(0, 1200)
    return first1k.replace(/\n+/g, ' | ')
  } catch (e) { return null }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  // vet — fetch the header of 113090 each subject
  console.log('=== 獸醫師 113090 all 6 subjects (full header) ===')
  for (const s of ['11','22','33','44','55','66']) {
    const r = await head('113090', '314', s)
    if (r) console.log(`\n--- s=${s} ---\n${r.slice(0, 400)}`)
    await sleep(300)
  }

  // Check vet 114/115
  console.log('\n\n=== 獸醫師 114/115 availability ===')
  for (const y of ['114','115']) {
    for (const suf of ['020','070','080','090','100']) {
      const r = await head(y+suf, '314', '11')
      if (r) console.log(`  ${y}${suf} s=11: ${r.slice(0, 150)}`)
      await sleep(150)
    }
  }

  // Check tcm 114/115
  console.log('\n\n=== 中醫師 114/115 availability ===')
  for (const y of ['114','115']) {
    for (const suf of ['020','070','080','090','100']) {
      for (const c of ['317','318']) {
        const r = await head(y+suf, c, '11')
        if (r) console.log(`  ${y}${suf} c=${c} s=11: ${r.slice(0, 150)}`)
        await sleep(150)
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
