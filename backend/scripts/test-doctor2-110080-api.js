#!/usr/bin/env node
/**Test which class code works for 110080*/

const https = require('https')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

async function testUrl(c, s) {
  const url = `${BASE}?t=Q&code=110080&c=${c}&s=${s}&q=1`
  return new Promise((resolve) => {
    const req = https.get(url, {
      rejectUnauthorized: false,
      timeout: 5000,
      headers: { 'User-Agent': UA }
    }, (res) => {
      const status = res.statusCode
      const ct = (res.headers['content-type'] || '').substring(0, 30)
      res.resume()
      resolve({ c, s, status, type: ct })
    })
    req.on('error', () => resolve({ c, s, status: 'ERROR', type: '' }))
    req.on('timeout', () => { req.destroy(); resolve({ c, s, status: 'TIMEOUT', type: '' }) })
  })
}

;(async () => {
  console.log('\n=== Testing 110080 URLs ===\n')

  // Try different class codes
  const tests = [
    { c: '301', s: '11', desc: '301/11' },
    { c: '301', s: '22', desc: '301/22' },
    { c: '302', s: '11', desc: '302/11' },
    { c: '302', s: '22', desc: '302/22' },
  ]

  for (const t of tests) {
    const result = await testUrl(t.c, t.s)
    const ok = result.status === 200 ? '✓' : '✗'
    console.log(`${ok} c=${result.c} s=${result.s}: HTTP ${result.status} (${result.type})`)
  }
})()
