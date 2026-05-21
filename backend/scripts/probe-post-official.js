#!/usr/bin/env node
/**
 * Probe: 中華郵政官方試題索引 — 來源：金融研訓院 svc.tabf.org.tw（官方甄試承辦系統）
 *
 * svc.tabf.org.tw/{ed}/Paper/History?EPID={epid} 是官方歷屆題庫，PDF 直連、無 WAF。
 * PDF 為「試題＋答案合一」（題號前綴【X】），與三民格式相同 → 共用 lib/post-parser.js。
 * 官方試題依著作權法 §9（依法令舉行之考試）不受著作權保護。
 *
 * 各 EPID 對應一個年度（流水號）：
 *   111→10272, 112→10273, 113→10274（資訊類科專場）, 114→10315
 *
 *   node scripts/probe-post-official.js     # 下載+分類 → _tmp/_post-official-index.json
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')
const { cachedFetch } = require('./lib/pdf-fetcher')

const SITE = 'https://svc.tabf.org.tw'
const ROOT = path.join(__dirname, '..')
const CACHE_DIR = path.join(ROOT, '_tmp', 'post-official-cache')
const INDEX_FILE = path.join(ROOT, '_tmp', '_post-official-index.json')
const https = require('https')

const SOURCES = [
  { ed: '114post01', epid: 10272, year: '111' },
  { ed: '114post01', epid: 10273, year: '112' },
  { ed: '114post01', epid: 10274, year: '113' },
  { ed: '115post02', epid: 10315, year: '114' },
]
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false, timeout: 35000,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Referer': SITE + '/' } }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')) })
  })
}

// 從 PDF 開頭文字判 {rank, category, subject, paperType}
function classify(text) {
  const head = text.slice(0, 600).replace(/[ \t]+/g, ' ')
  const flat = head.replace(/\s+/g, '')
  let rank = null
  if (/專業職\(二\)內勤|專業職（二）內勤/.test(flat)) rank = '專業職二內勤'
  else if (/專業職\(二\)外勤|專業職（二）外勤/.test(flat)) rank = '專業職二外勤'
  else if (/專業職\(二\)/.test(flat)) rank = '專業職二'
  else if (/專業職\(一\)/.test(flat)) rank = '專業職一'
  else if (/營運職/.test(flat)) rank = '營運職'
  const catM = flat.match(/類科【代碼】：[^／]*／([^【]+?)【/)
  const subjM = flat.match(/第[一二三四五六七]節[／/](?:專業科目|共同科目)[^：]*：([^＊]+?)(?:＊|注意)/)
  const mcq = (text.match(/【\s*[1-4](?:[,，、][1-4])*\s*】\s*\d{1,3}\s*[.．、]?/g) || []).length
  return {
    rank,
    category: catM ? catM[1].trim() : null,
    subject: subjM ? subjM[1].trim() : null,
    mcq,
    isMcqPaper: mcq >= 10,
  }
}

async function main() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })
  const index = []

  for (const src of SOURCES) {
    const histUrl = `${SITE}/${src.ed}/Paper/History?EPID=${src.epid}`
    let html
    try { html = await fetchHtml(histUrl) }
    catch (e) { console.log(`✗ ${src.year}年 EPID ${src.epid}: ${e.message}`); continue }
    const pdfs = [...new Set([...html.matchAll(/\/_File\/Download\/[^"']+\.pdf/gi)].map(m => m[0]))]
    console.log(`\n${src.year}年 (EPID ${src.epid}): ${pdfs.length} PDF`)

    for (const rel of pdfs) {
      const url = SITE + rel
      let info
      try {
        const buf = await cachedFetch(url, CACHE_DIR, { referer: SITE + '/', timeout: 45000 })
        const { text } = await pdfParse(buf)
        info = classify(text)
        // 驗證年度
        const ym = text.match(/(\d{2,3})\s*年職階人員/)
        info.pdfYear = ym ? ym[1] : null
      } catch (e) {
        console.log(`  ✗ ${rel}: ${e.message}`)
        continue
      }
      index.push({ year: src.year, epid: src.epid, url, ...info })
      const flag = info.isMcqPaper ? `選擇題x${info.mcq}` : '非選/申論'
      console.log(`  [${flag}] ${info.rank || '?'} / ${info.category || '?'} / ${info.subject || '?'}`)
      await new Promise(r => setTimeout(r, 120))
    }
  }

  fs.writeFileSync(INDEX_FILE, JSON.stringify({ scrapedAt: new Date().toISOString(), total: index.length, papers: index }, null, 2))
  console.log(`\n✅ 索引 ${index.length} 份 → ${INDEX_FILE}`)
  // 統計
  const stat = {}
  for (const p of index) {
    const k = `${p.year} ${p.rank || '?'}`
    stat[k] ??= { mcq: 0, essay: 0 }
    p.isMcqPaper ? stat[k].mcq++ : stat[k].essay++
  }
  for (const [k, v] of Object.entries(stat).sort()) console.log(`  ${k}: 選擇題 ${v.mcq}、非選 ${v.essay}`)
}

main().catch(e => { console.error(e); process.exit(1) })
