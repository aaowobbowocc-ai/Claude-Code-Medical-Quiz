#!/usr/bin/env node
// Survey all 普通考試 類科 (113080) and their professional 概要 subjects.
// For each c=401..420, scans s codes; records (類科, 科目, hasMCQ).
// Output: scripts/_civil-junior-survey.json — basis for B2 類科 expansion.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const https = require('https')
const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const CODE = '113080' // latest 普考 session
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'

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

async function probe(c, s) {
  let buf
  try { buf = await fetchPdf(`${BASE}?t=Q&code=${CODE}&c=${c}&s=${s}&q=1`) } catch { return null }
  if (!buf || buf.length < 4000) return null
  let d
  try { d = await pdfParse(buf) } catch { return null }
  const t = d.text.replace(/\s+/g, ' ')
  const cls = (t.match(/類\s*科[名稱]*\s*[：:]\s*([^ ]{1,40})/) || [])[1] || ''
  const sub = (t.match(/科\s*目[名稱]*\s*[：:]\s*([^ ]{1,40})/) || [])[1] || ''
  const mcq = /選擇題|測驗題/.test(t)
  return { cls, sub, mcq }
}

async function main() {
  const results = []
  for (let c = 401; c <= 420; c++) {
    const found = []
    for (let P = 1; P <= 9; P++) {
      for (let MM = 1; MM <= 13; MM++) {
        const s = `0${P}${String(MM).padStart(2, '0')}`
        const r = await probe(String(c), s)
        await sleep(130)
        if (!r || !r.sub) continue
        if (found.some(f => f.sub === r.sub)) continue
        found.push({ s, ...r })
      }
    }
    if (found.length) {
      console.log(`\nc=${c}:`)
      for (const f of found) console.log(`  s=${f.s}  ${f.mcq ? 'MCQ' : '申論'}  類科=${f.cls}  科目=${f.sub}`)
      results.push({ c: String(c), papers: found })
    }
  }
  fs.writeFileSync(path.join(__dirname, '_civil-junior-survey.json'), JSON.stringify(results, null, 2))
  console.log('\n→ saved scripts/_civil-junior-survey.json')
}
main().catch(e => { console.error(e); process.exit(1) })
