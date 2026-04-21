#!/usr/bin/env node
// Probe MoEX to find class + subject codes for image-bearing exams
const https = require('https')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

function headPdf(url, retries = 1) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 10000,
      headers: { 'User-Agent': UA, 'Accept': 'application/pdf,*/*', 'Referer': 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume()
        return resolve({ ok: false, status: 302, loc: res.headers.location })
      }
      if (res.statusCode !== 200) { res.resume(); return resolve({ ok: false, status: res.statusCode }) }
      const ct = res.headers['content-type'] || ''
      const cl = res.headers['content-length'] || '?'
      res.resume()
      return resolve({ ok: ct.includes('pdf') || ct.includes('octet'), ct, cl })
    })
    req.on('error', () => resolve({ ok: false, err: true }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, err: 'timeout' }) })
  })
}

;(async () => {
  const probes = [
    // dental2
    { tag: 'dental2', code: '110020', cs: ['303', '304'], ss: ['11','22','33','44','0101','0201','0301'] },
    // dental1
    { tag: 'dental1', code: '110020', cs: ['303','304','305','306'], ss: ['11','22'] },
    // pharma1 / pharma2
    { tag: 'pharma1', code: '110020', cs: ['309','310'], ss: ['11','22','33','0101'] },
    { tag: 'pharma2', code: '110020', cs: ['309','310','405'], ss: ['11','22','33'] },
  ]
  for (const p of probes) {
    for (const c of p.cs) {
      for (const s of p.ss) {
        const url = `${BASE}?t=Q&code=${p.code}&c=${c}&s=${s}&q=1`
        const r = await headPdf(url)
        if (r.ok) console.log('✓', p.tag, 'c='+c, 's='+s, 'len='+r.cl)
        await new Promise(r => setTimeout(r, 100))
      }
    }
  }
})()
