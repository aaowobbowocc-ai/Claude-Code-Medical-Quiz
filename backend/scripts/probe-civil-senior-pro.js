#!/usr/bin/env node
// Probe MoEX for 高考三級 一般行政 professional-subject (code,c,s) per year.
// Targets the 4 not-yet-scraped subjects: 政治學, 公共政策, 公共管理, 民法總則與刑法總則.
// Scans s = 0P MM for P in 1..8, MM in 01..16; verifies 類科 includes 一般行政.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const https = require('https')
const pdfParse = require('pdf-parse')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'

// year → { code, c } for 高考三級 一般行政 (c verified from scrape-civil-senior.js)
const SESSIONS = [
  { year: '106', code: '106090', c: '201' },
  { year: '107', code: '107090', c: '301' },
  { year: '108', code: '108090', c: '201' },
  { year: '109', code: '109090', c: '301' },
  { year: '110', code: '110090', c: '301' },
  { year: '111', code: '111090', c: '301' },
  { year: '112', code: '112090', c: '301' },
  { year: '113', code: '113080', c: '301' },
  { year: '114', code: '114080', c: '201' },
]

function fetchPdf(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 15000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*' },
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
  const url = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
  let buf
  try { buf = await fetchPdf(url) } catch { return null }
  if (!buf || buf.length < 4000) return null
  let d
  try { d = await pdfParse(buf) } catch { return null }
  const t = d.text.replace(/\s+/g, ' ')
  const cls = t.match(/類\s*科[名稱]*\s*[：:]\s*([^ ]{1,30})/)?.[1] || ''
  const sub = t.match(/科\s*目[名稱]*\s*[：:]\s*([^ ]{1,40})/)?.[1] || ''
  return { cls, sub }
}

async function main() {
  const results = {}
  for (const sess of SESSIONS) {
    console.log(`\n=== ${sess.year} (code=${sess.code} c=${sess.c}) ===`)
    const found = {}
    for (let P = 1; P <= 8 && Object.keys(found).length < 8; P++) {
      for (let MM = 1; MM <= 16; MM++) {
        const s = `0${P}${String(MM).padStart(2, '0')}`
        const r = await probe(sess.code, sess.c, s)
        await sleep(200)
        if (!r || !r.cls) continue
        if (!r.cls.includes('一般行政')) continue
        if (found[r.sub]) continue
        found[r.sub] = s
        console.log(`  ✓ s=${s}  科目=${r.sub}`)
        if (Object.keys(found).length >= 8) break
      }
    }
    results[sess.year] = { code: sess.code, c: sess.c, subjects: found }
  }
  require('fs').writeFileSync(
    require('path').join(__dirname, '_civil-senior-pro-probe.json'),
    JSON.stringify(results, null, 2))
  console.log('\n→ saved scripts/_civil-senior-pro-probe.json')
}
main().catch(e => { console.error(e); process.exit(1) })
