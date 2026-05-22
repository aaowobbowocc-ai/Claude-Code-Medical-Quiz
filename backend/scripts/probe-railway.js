#!/usr/bin/env node
// Discover 鐵路特考佐級 (運輸營業 c=903-ish / 事務管理 c=901-ish) session/class/subject codes
// for years 100-112. Outputs scripts/_railway-map.json.
// 鐵路特考 was discontinued after 112 (台鐵 corporatised 2024).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const https = require('https')
const fs = require('fs')
const path = require('path')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const sleep = ms => new Promise(r => setTimeout(r, ms))

function get(url, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const r = https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      rejectUnauthorized: false, timeout: 30000,
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9', ...(cookie ? { Cookie: cookie } : {}) },
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }))
      res.on('error', reject)
    })
    r.on('error', reject)
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')) })
  })
}

// fetch a results page, following 301/302
async function ff(url) {
  let cookie = ''
  for (let i = 0; i < 6; i++) {
    const r = await get(url, cookie)
    if (r.headers['set-cookie']) cookie = r.headers['set-cookie'].map(c => c.split(';')[0]).join('; ')
    if (r.status === 302 || r.status === 301) { url = new URL(r.headers.location, url).href; continue }
    return r
  }
  return null
}

const SEARCH = 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx'

// Extract exam dropdown: [{code, name}]
function examList(html) {
  const sel = html.match(/<select[^>]*ddlExamCode[^>]*>([\s\S]*?)<\/select>/i)
  if (!sel) return []
  const out = []
  const re = /value="(\d{6})"[^>]*>([^<]+)</g
  let m
  while ((m = re.exec(sel[1]))) out.push({ code: m[1], name: m[2].trim() })
  return out
}

// Extract Q-link c/s per 類科 from a results page, scoped to 鐵路 + 佐級
function railwayJuniorCodes(html, code) {
  const decoded = html.replace(/&amp;/g, '&')
  const re = new RegExp(`wHandExamQandA_File\\.ashx\\?t=Q&code=${code}&c=(\\d+)&s=(\\d+)&q=1`, 'g')
  let m
  const seen = new Set()
  const byC = {}
  while ((m = re.exec(decoded))) {
    const key = m[1] + '_' + m[2]
    if (seen.has(key)) continue
    seen.add(key)
    const ctx = decoded.slice(Math.max(0, m.index - 360), m.index)
    const t = ctx.match(/開啓([^<]{2,70}?)試題\(Pdf檔\)/g)
    const name = t ? t[t.length - 1].replace(/^開啓/, '').replace(/試題\(Pdf檔\)$/, '') : '?'
    ;(byC[m[1]] = byC[m[1]] || []).push({ s: m[2], name })
  }
  // a 佐級 類科 = group whose subjects include 國文 + 公民與英文 + two 大意
  const result = {}
  for (const [c, subs] of Object.entries(byC)) {
    const names = subs.map(x => x.name).join('、')
    if (!/公民與英文/.test(names)) continue
    let kind = null
    if (/事務管理大意/.test(names) && /法學大意/.test(names)) kind = 'admin'
    else if (/運輸學大意/.test(names) && /企業管理大意/.test(names)) kind = 'transport'
    if (!kind) continue
    const sMap = {}
    for (const x of subs) sMap[x.s] = x.name
    result[kind] = { c, subjects: sMap }
  }
  return result
}

// One known-good session code per year — used only to populate the year's
// exam dropdown (1 request/year instead of brute-forcing).
const SEED = {
  100: '100030', 101: '101030', 102: '102020', 103: '103020', 104: '104020',
  105: '105030', 106: '106030', 107: '107030', 108: '108070', 109: '109070',
  110: '110070', 111: '111070', 112: '112070',
}

async function main() {
  const only = process.env.YEARS ? process.env.YEARS.split(',').map(Number) : null
  const mapPath = path.join(__dirname, '_railway-map.json')
  const map = only && fs.existsSync(mapPath) ? JSON.parse(fs.readFileSync(mapPath, 'utf-8')) : {}
  for (let roc = 100; roc <= 112; roc++) {
    if (only && !only.includes(roc)) continue
    const y = String(1911 + roc) // ROC year → AD
    const lp = await ff(`${SEARCH}?y=${y}&e=${SEED[roc]}`)
    await sleep(2500)
    let exams = lp && lp.body.length > 50000 ? examList(lp.body) : []
    // exclude 升資/升官等 (promotion exams — different structure, no 佐級)
    const rail = exams.find(e => /鐵路/.test(e.name) && !/升資|升官等/.test(e.name))
    if (!rail) {
      console.log(`${roc}: no 鐵路 exam (dropdown had ${exams.length}; seed ${SEED[roc]})`)
      await sleep(1000)
      continue
    }
    const resPage = await ff(`${SEARCH}?y=${y}&e=${rail.code}`)
    if (!resPage) { console.log(`${roc}: ${rail.code} results failed`); await sleep(1500); continue }
    const codes = railwayJuniorCodes(resPage.body, rail.code)
    map[roc] = { sessionCode: rail.code, examName: rail.name, ...codes }
    console.log(`${roc}: ${rail.code}  transport=${JSON.stringify(codes.transport || null)}  admin=${JSON.stringify(codes.admin || null)}`)
    await sleep(2000)
  }
  fs.writeFileSync(path.join(__dirname, '_railway-map.json'), JSON.stringify(map, null, 2))
  console.log('\n→ saved scripts/_railway-map.json')
}
main().catch(e => { console.error(e); process.exit(1) })
