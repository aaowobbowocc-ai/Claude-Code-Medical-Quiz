#!/usr/bin/env node
// Phase 1: discover MoEX session codes for 100-105 + identify each session's exam.
// Scans code=YYY010..YYY200 (step 10), with c=101..501 (step 100), s=0101.
// For each PDF, reads first ~250 chars to identify exam type.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const https = require('https')
const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

function fetchPdf(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/pdf,*/*' },
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(String(res.statusCode))) }
      const cs = []; res.on('data', c => cs.push(c)); res.on('end', () => resolve(Buffer.concat(cs)))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function probe(code, c, s) {
  let buf
  try { buf = await fetchPdf(`${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`) } catch { return null }
  if (!buf || buf.length < 3000) return null
  let d
  try { d = await pdfParse(buf) } catch { return null }
  const t = d.text.replace(/\s+/g, ' ')
  // First chunk usually has 考試名稱
  const title = t.slice(0, 200)
  const cls = (t.match(/類\s*科[名稱]*\s*[：:]\s*([^ ]{1,30})/) || [])[1] || ''
  const sub = (t.match(/科\s*目[名稱]*\s*[：:]\s*([^ ]{1,30})/) || [])[1] || ''
  return { title, cls, sub }
}

async function main() {
  const sessions = []
  const years = ['100', '101', '102', '103', '104', '105']
  for (const y of years) {
    console.log(`\n--- year ${y} ---`)
    for (let xxx = 10; xxx <= 200; xxx += 10) {
      const code = y + String(xxx).padStart(3, '0')
      let foundForCode = false
      for (const c of ['101', '201', '301', '401', '501']) {
        const r = await probe(code, c, '0101')
        await sleep(70)
        if (!r) continue
        foundForCode = true
        sessions.push({ year: y, code, c, ...r })
        // Identify exam name from title
        const examHint = (r.title.match(/(專門職業及技術人員[^考]*考試|公務人員[^考]*考試|司法人員[^考]*考試|律師考試|警察人員[^考]*考試|關務人員考試|地方政府公務人員考試|社會工作師考試|專技[^考]*考試)/) || [])[1] || r.title.slice(0, 60)
        console.log(`  ${code} c=${c}: ${examHint}  [類科=${r.cls}]`)
        break // one c-hit per code is enough for Phase 1 identification
      }
    }
  }
  fs.writeFileSync(path.join(__dirname, '_100_105_sessions.json'), JSON.stringify(sessions, null, 2))
  console.log(`\n→ ${sessions.length} sessions found, saved scripts/_100_105_sessions.json`)
}
main().catch(e => { console.error(e); process.exit(1) })
