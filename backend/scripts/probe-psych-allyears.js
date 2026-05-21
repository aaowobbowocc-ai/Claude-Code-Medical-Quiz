#!/usr/bin/env node
// 完整 probe 100-110 心理師所有測驗卷 (code,c,s,subject,hasMCQ)。
// 輸出 scripts/_psych-fullmap.json 供 backfill 用。

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const https = require('https')
const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const CODES = [
  '100030','100140','101030','101110','102030','102110','103030','103100',
  '104030','104100','105090','106030','106110','107030','107110','108020',
  '108110','109030','109110','110111',
]

function fetchPdf(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized: false, timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/pdf,*/*' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(String(res.statusCode))) }
      const cs = []; res.on('data', c => cs.push(c)); res.on('end', () => resolve(Buffer.concat(cs)))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('t')) })
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
  const cls = (t.match(/類\s*科[名稱]*\s*[：:]\s*([^ ]{1,16})/) || [])[1] || ''
  const sub = (t.match(/科\s*目[名稱]*\s*[：:]\s*([^ ]{1,40})/) || [])[1] || ''
  return { cls, sub, mcq: /測驗題|選擇題/.test(t) }
}

async function main() {
  const out = {}
  for (const code of CODES) {
    out[code] = {}
    for (let c = 103; c <= 112; c++) {
      const found = []
      for (let P = 3; P <= 9; P++) {
        for (let MM = 1; MM <= 12; MM++) {
          const s = `0${P}${String(MM).padStart(2, '0')}`
          const r = await probe(code, String(c), s)
          await sleep(28)
          if (!r || !r.sub) continue
          // 類科欄常為空 → 改用科目名稱判斷（臨床心理學/諮商…）
          if (!/心理師/.test(r.cls) && !/臨床心理學|諮商|心理衡鑑|變態心理|心理治療|心理健康/.test(r.sub)) continue
          found.push({ s, cls: r.cls, sub: r.sub, mcq: r.mcq })
        }
      }
      if (found.length) {
        out[code][c] = found
        console.log(`${code} c=${c} [${found[0].cls}]: ${found.map(f => f.s + (f.mcq ? '' : '申')).join(' ')}`)
      }
    }
  }
  fs.writeFileSync(path.join(__dirname, '_psych-fullmap.json'), JSON.stringify(out, null, 2))
  console.log('\n→ saved scripts/_psych-fullmap.json')
}
main().catch(e => { console.error(e); process.exit(1) })
