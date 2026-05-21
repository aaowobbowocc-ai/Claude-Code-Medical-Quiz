#!/usr/bin/env node
/**
 * Probe: 中華郵政（郵局招考）試題索引 — 來源：三民輔考 3people.com.tw
 *
 * 官方題源（金研院 svc.tabf.org.tw）有 WAF 防爬，改用三民輔考公開的「考古題下載」PDF。
 * ⚠️ 補習班「詳解」受其著作權保護；這些 PDF 本身只含試題+答案（無詳解），仍只取試題+答案。
 *
 * 三民只有兩個入口頁（.aspx=105 年、網頁頁=104 年），其餘年度的 PDF 存在 server 上
 * 但無入口連結。考古題路徑規律為 /重要考訊/考古題/國營事業/郵局/{year}/{相對路徑}，
 * 106 年起命名一致。故採「迭代式路徑探測」：以入口頁清單為初始模板，逐年 HEAD 套用，
 * 把每輪新命中的相對路徑加回模板，多輪滾動直到收斂。
 *
 *   node scripts/probe-post.js          # → _tmp/_post-index.json
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const https = require('https')
const fs = require('fs')
const path = require('path')

const SITE = 'https://www.3people.com.tw'
const BASE = '/重要考訊/考古題/國營事業/郵局/'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const OUT_DIR = path.join(__dirname, '..', '_tmp')
const INDEX_FILE = path.join(OUT_DIR, '_post-index.json')

const ENTRY_PAGES = [
  '/Government/mail/base/中華郵政考古題.aspx',
  '/網頁/考古題下載/國營事業-中華郵政/53/c77a16fe-372b-4acd-9143-3718e6eaf896',
]
const YEARS = ['100','101','102','103','104','105','106','107','108','109','110','111','112','113','114','115']
const MAX_ROUNDS = 5

function request(method, url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('too many redirects'))
    const r = https.request(url, {
      method, rejectUnauthorized: false, timeout: 30000,
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'zh-TW,zh;q=0.9', 'Referer': SITE + '/' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        let loc = res.headers.location
        if (!loc.startsWith('http')) loc = SITE + loc
        return request(method, loc, depth + 1).then(resolve, reject)
      }
      if (method === 'HEAD') {
        res.resume()
        return resolve({ status: res.statusCode, ctype: res.headers['content-type'] || '', len: +(res.headers['content-length'] || 0) })
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }))
      res.on('error', reject)
    })
    r.on('error', reject)
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')) })
    r.end()
  })
}

const decode = s => s.replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))

function extractPdfs(html) {
  const out = new Set()
  for (const m of html.matchAll(/(?:href|src)\s*=\s*["']([^"']+\.pdf)["']/gi)) {
    let u = decode(m[1])
    if (!u.startsWith('http')) u = SITE + (u.startsWith('/') ? '' : '/') + u
    out.add(u)
  }
  return [...out]
}

// full URL → 年度後的相對路徑（已 decode），抓不到回 null
function toRel(url) {
  const dec = decodeURIComponent(url)
  const i = dec.indexOf(BASE)
  if (i < 0) return null
  const after = dec.slice(i + BASE.length)         // {year}/{rel}
  const m = after.match(/^(\d{3})\/(.+\.pdf)$/i)
  return m ? m[2] : null
}

async function headPdf(year, rel) {
  const url = SITE + encodeURI(BASE + year + '/' + rel)
  try {
    const h = await request('HEAD', url)
    const ok = h.status === 200 && (h.ctype.includes('pdf') || h.ctype.includes('octet') || h.len > 5000)
    return ok ? { len: h.len } : null
  } catch { return null }
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })

  // 1) 入口頁
  const entryPdfs = {}
  for (const page of ENTRY_PAGES) {
    try {
      const res = await request('GET', SITE + encodeURI(page))
      entryPdfs[page] = extractPdfs(res.body)
      console.log(`入口頁 ${page}: ${entryPdfs[page].length} PDF`)
    } catch (e) { console.log(`✗ ${page}: ${e.message}`); entryPdfs[page] = [] }
  }

  // 2) 初始模板：入口頁全部相對路徑
  const templates = new Set()
  for (const list of Object.values(entryPdfs)) for (const u of list) {
    const rel = toRel(u); if (rel) templates.add(rel)
  }
  console.log(`初始模板 ${templates.size} 條相對路徑`)

  // hits[year] = Set<rel>
  const hits = {}; for (const y of YEARS) hits[y] = new Set()

  // 3) 迭代探測
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let newFound = 0, tested = 0
    const tmplArr = [...templates]
    for (const year of YEARS) {
      for (const rel of tmplArr) {
        if (hits[year].has(rel)) continue
        tested++
        const r = await headPdf(year, rel)
        if (r) {
          hits[year].add(rel)
          if (!templates.has(rel)) { /* 已在 templates */ }
        }
        await new Promise(res => setTimeout(res, 45))
      }
    }
    // 把所有命中的 rel 併入模板（供下一輪跨年套用）
    const before = templates.size
    for (const y of YEARS) for (const rel of hits[y]) templates.add(rel)
    newFound = templates.size - before
    const total = YEARS.reduce((s, y) => s + hits[y].size, 0)
    console.log(`第 ${round} 輪：測試 ${tested}，累計命中 ${total}，模板新增 ${newFound}`)
    if (newFound === 0) break
  }

  // 4) 輸出
  const byYear = {}
  for (const y of YEARS) {
    if (!hits[y].size) continue
    byYear[y] = [...hits[y]].sort().map(rel => ({
      rel, url: SITE + encodeURI(BASE + y + '/' + rel),
    }))
  }
  const index = { fetchedAt: new Date().toISOString(), base: BASE, entryPdfs, byYear }
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2))
  console.log(`\n✅ 索引 → ${INDEX_FILE}`)
  for (const [y, arr] of Object.entries(byYear)) console.log(`  ${y} 年: ${arr.length} PDF`)
}

main().catch(e => { console.error(e); process.exit(1) })
