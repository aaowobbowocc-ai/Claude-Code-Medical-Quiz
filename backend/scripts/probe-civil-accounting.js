#!/usr/bin/env node
// Probe 普考 會計 類科 (code,c,s) per year 106-114.
// 會計 professional 概要 subjects sit at P=8/9; scans those bands only.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const https = require('https')
const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'

const SESSIONS = [
  ['106', '106090'], ['107', '107090'], ['108', '108090'], ['109', '109090'],
  ['110', '110090'], ['111', '111090'], ['112', '112090'], ['113', '113080'], ['114', '114080'],
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
  let buf
  try { buf = await fetchPdf(`${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`) } catch { return null }
  if (!buf || buf.length < 4000) return null
  let d
  try { d = await pdfParse(buf) } catch { return null }
  const t = d.text.replace(/\s+/g, ' ')
  const cls = (t.match(/類\s*科[名稱]*\s*[：:]\s*([^ ]{1,30})/) || [])[1] || ''
  const sub = (t.match(/科\s*目[名稱]*\s*[：:]\s*([^ ]{1,30})/) || [])[1] || ''
  return { cls, sub, mcq: /選擇題|測驗題/.test(t) }
}

async function main() {
  const out = {}
  for (const [y, code] of SESSIONS) {
    let acctC = null, papers = []
    for (let c = 413; c <= 421 && !acctC; c++) {
      for (let P = 8; P <= 9; P++) {
        for (let MM = 1; MM <= 14; MM++) {
          const s = `0${P}${String(MM).padStart(2, '0')}`
          const r = await probe(code, String(c), s)
          await sleep(80)
          if (!r || !r.cls) continue
          if (!/會計/.test(r.cls)) continue
          acctC = String(c)
          if (/會計|成本/.test(r.sub) && !papers.some(p => p.sub === r.sub)) {
            papers.push({ s, sub: r.sub, mcq: r.mcq })
          }
        }
      }
    }
    out[y] = { code, c: acctC, papers }
    console.log(y, 'c=' + (acctC || '?'), JSON.stringify(papers))
  }
  fs.writeFileSync(path.join(__dirname, '_accounting-probe.json'), JSON.stringify(out, null, 2))
  console.log('\n→ saved scripts/_accounting-probe.json')
}
main().catch(e => { console.error(e); process.exit(1) })
