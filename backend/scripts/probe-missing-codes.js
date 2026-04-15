#!/usr/bin/env node
// Probe which MoEX session codes return real PDFs for:
//   - TCM 115 第一次 (classes 317/318)
//   - Nutrition 112 第二次 (class 102)
//   - Radiology 110-113 (class 309)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const https = require('https')
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'

function headPdf(url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 15000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*', Referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location || ''
        res.resume()
        if (!loc.startsWith('http')) return resolve({ ok: false, reason: `302→${loc.slice(0, 40)}` })
        return resolve({ ok: false, reason: `302→abs` })
      }
      if (res.statusCode !== 200) { res.resume(); return resolve({ ok: false, reason: `HTTP ${res.statusCode}` }) }
      const ct = res.headers['content-type'] || ''
      const cl = res.headers['content-length'] || '?'
      res.resume()
      if (!ct.includes('pdf') && !ct.includes('octet')) return resolve({ ok: false, reason: `ct=${ct}` })
      resolve({ ok: true, bytes: cl })
    })
    req.on('error', e => resolve({ ok: false, reason: e.message.slice(0, 40) }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }) })
  })
}

function url(code, classCode, s, t = 'Q') {
  return `${BASE}?t=${t}&code=${code}&c=${classCode}&s=${s}&q=1`
}

async function probe(label, code, classCode, s) {
  const r = await headPdf(url(code, classCode, s))
  console.log(`  [${r.ok ? 'OK ' : '--'}] ${label.padEnd(40)} c=${classCode} code=${code} s=${s.toString().padEnd(4)} ${r.ok ? r.bytes + 'B' : r.reason}`)
  return r.ok
}

async function main() {
  console.log('\n=== TCM 115 第一次 (tcm1: c=317, tcm2: c=318) ===')
  // Try plausible 115 codes: 115020 (same as doctor1 第一次), 115010
  for (const code of ['115020', '115010', '115030']) {
    for (const [label, c, s] of [['tcm1-基(一)', '317', '0201'], ['tcm1-基(二)', '317', '0202'], ['tcm2-臨(一)', '318', '0201']]) {
      await probe(`${label} ${code}`, code, c, s)
    }
  }

  console.log('\n=== Nutrition 112 第二次 (c=102) ===')
  // second-session suffixes seen: 110111, 111110, 113100, 114100 — try 112100/110/111
  for (const code of ['112100', '112110', '112111', '112090', '112080']) {
    await probe(`營養-膳食療養 ${code}`, code, '102', '0201')
  }

  console.log('\n=== Radiology 110-113 (c=309, s=0108 or older) ===')
  // 114020 confirmed working; try same code family backwards
  for (const year of ['110', '111', '112', '113']) {
    for (const code of [`${year}020`, `${year}090`, `${year}010`, `${year}100`]) {
      await probe(`放射-基礎 ${code}`, code, '309', '0108')
    }
  }

  console.log('\n=== Radiology 110-113 with 2-digit s codes (some old years use 2-digit) ===')
  for (const year of ['110', '111', '112', '113']) {
    for (const code of [`${year}020`, `${year}090`]) {
      await probe(`放射-基礎 ${code} s=11`, code, '309', '11')
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
