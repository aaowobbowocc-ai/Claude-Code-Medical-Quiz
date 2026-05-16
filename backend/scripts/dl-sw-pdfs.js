#!/usr/bin/env node
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const https = require('https')
const fs = require('fs')
const path = require('path')
const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')

function dl(url, dest) {
  return new Promise((resolve) => {
    https.get(url, { timeout: 20000 }, res => {
      if (res.statusCode !== 200) { res.resume(); return resolve(false) }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        if (buf.length < 2000) return resolve(false)
        fs.writeFileSync(dest, buf)
        resolve(true)
      })
    }).on('error', () => resolve(false)).on('timeout', function () { this.destroy(); resolve(false) })
  })
}

async function main() {
  const SESSIONS = ['112030', '112110', '113030', '113100', '114030', '114100', '115030']
  const S = ['0301', '0302', '0303']
  let ok = 0
  for (const code of SESSIONS) {
    for (const s of S) {
      const url = `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=Q&code=${code}&c=103&s=${s}&q=1`
      const dest = path.join(PDF_CACHE, `social-worker_${code}_c103_s${s}.pdf`)
      if (fs.existsSync(dest)) { ok++; continue }
      const r = await dl(url, dest)
      console.log(r ? '✓' : '✗', `${code} s${s}`)
      if (r) ok++
    }
  }
  console.log('downloaded/exist:', ok, '/ 21')
}
main()
