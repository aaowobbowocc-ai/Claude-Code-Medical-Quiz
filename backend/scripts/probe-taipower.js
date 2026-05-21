#!/usr/bin/env node
/**
 * Probe: 經濟部國營事業聯招（台電官網）試題索引建立
 *
 * 列表頁用 q_attribute 參數做「年度」篩選（每年一個 id）。預設頁只顯示近年，
 * 舊年度必須帶 q_attribute 才看得到 → 逐年抓。
 *
 * 各年度檔名命名不一致（試題解答A / 解答科目A / 試題科目A …），故每個
 * 年度×類別收集「所有可能含題目+答案的 PDF」為候選清單，交由爬蟲逐一嘗試解析、取最佳。
 *
 *   node scripts/probe-taipower.js            # 抓全部年度、寫 index
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const https = require('https')
const fs = require('fs')
const path = require('path')

const LIST = 'https://www.taipower.com.tw/2289/2544/2554/2556/'
const SITE = 'https://www.taipower.com.tw'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const INDEX_FILE = path.join(__dirname, '..', '_tmp', '_taipower-index.json')

// 民國年 → q_attribute id（年度篩選）
const YEAR_QATTR = {
  '114': 4300, '113': 4298, '112': 4296, '111': 4224, '110': 4119, '109': 3032,
  '108': 2714, '107': 2656, '106': 353, '105': 354, '104': 355, '103': 559,
  '102': 558, '101': 557, '100': 556,
}

const TARGET_CATS = ['企管', '人資', '財會', '資訊']

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false,
      timeout: 25000,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9',
        'Referer': 'https://www.taipower.com.tw/',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return fetchHtml(res.headers.location).then(resolve, reject)
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

// 解析下載連結 title → { category, isEssay }；非甄試試題回 null
function classify(title) {
  const t = title.replace(/（另開新視窗）\s*$/, '').trim()
  if (!/甄試/.test(t)) return null
  const isEssay = /科目\s*[Bb]/.test(t)            // 科目B = 申論／計算題
  let category = null
  if (/共同/.test(t)) category = '共同科目'
  else for (const c of TARGET_CATS) { if (t.includes(c)) { category = c; break } }
  if (!category) return null
  if (category === '共同科目' && isEssay) return null   // 共同無 B
  return { category, isEssay }
}

async function main() {
  const index = {}
  for (const [year, qa] of Object.entries(YEAR_QATTR)) {
    let res
    try {
      res = await fetchHtml(`${LIST}?Page=1&PageSize=300&q_attribute=${qa}`)
    } catch (e) {
      console.log(`${year}年: ✗ ${e.message}`); continue
    }
    const links = [...res.body.matchAll(/<a[^>]+href="(\/media\/[^"]+)"[^>]*title="([^"]+)"/g)]
    let mcq = 0, essay = 0
    index[year] = {}
    for (const m of links) {
      const url = SITE + m[1]
      const meta = classify(m[2])
      if (!meta) continue
      const slot = (index[year][meta.category] ??= { mcq: [], essay: null })
      if (meta.isEssay) { if (!slot.essay) { slot.essay = url; essay++ } }
      else { slot.mcq.push(url); mcq++ }
    }
    console.log(`${year}年 (q_attribute=${qa}): MCQ候選 ${mcq}, 申論 ${essay}`)
    await new Promise(r => setTimeout(r, 500))
  }

  if (!fs.existsSync(path.dirname(INDEX_FILE))) fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true })
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2))
  console.log(`\n✅ 索引 → ${INDEX_FILE}`)
}

main().catch(e => { console.error(e); process.exit(1) })
