#!/usr/bin/env node
// Full per-year survey to locate 普考 會計 類科 (c shuffles every year).
// Scans c=406..420, P=4..9; records any paper whose 科目 contains 會計/成本.
// Identifies the 會計 c via uniquely-會計 papers (政府會計概要 / 會計法規概要).

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const https = require('https')
const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'

const SESSIONS = [
  ['106', '106090'], ['107', '107090'], ['108', '108090'], ['109', '109090'],
  ['110', '110090'], ['111', '111090'], ['112', '112090'],
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
    let acctC = null
    const hits = []
    for (let c = 406; c <= 420; c++) {
      for (let P = 4; P <= 9; P++) {
        for (let MM = 1; MM <= 13; MM++) {
          const s = `0${P}${String(MM).padStart(2, '0')}`
          const r = await probe(code, String(c), s)
          await sleep(65)
          if (!r || !r.sub) continue
          if (/會計|成本/.test(r.sub)) {
            hits.push({ c: String(c), s, cls: r.cls, sub: r.sub, mcq: r.mcq })
            // 政府會計概要 / 會計法規概要 are uniquely 會計 → pins the c
            if (/政府會計|會計法規/.test(r.sub)) acctC = String(c)
          }
        }
      }
    }
    out[y] = { code, c: acctC, hits }
    console.log(`${y} c=${acctC || '?'}  ${hits.map(h => `[c${h.c} ${h.s} ${h.sub}${h.mcq ? '' : '(申)'}]`).join(' ')}`)
  }
  fs.writeFileSync(path.join(__dirname, '_accounting-full-probe.json'), JSON.stringify(out, null, 2))
  console.log('\n→ saved scripts/_accounting-full-probe.json')
}
main().catch(e => { console.error(e); process.exit(1) })
