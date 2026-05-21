#!/usr/bin/env node
/**
 * 中華郵政 專業職(一) / 營運職 申論卷封存 — 不上線，僅備份
 *
 * 中華郵政專業職(一)、營運職的專業科目為申論題／計算題，無法做成選擇題對戰
 * 題庫（詳見 _classify-post.js 全量判定）。依使用者指示，這些卷仍爬下來存進
 * _archive/post-essay/ 備份，日後若做申論練習 / 閱讀功能可用。
 *
 *   node scripts/archive-post-essay.js
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const fs = require('fs')
const path = require('path')
const { cachedFetch } = require('./lib/pdf-fetcher')

const ROOT = path.join(__dirname, '..')
const CLASSIFIED = path.join(ROOT, '_tmp', '_post-classified.json')
const CACHE_DIR = path.join(ROOT, '_tmp', 'post-cache')
const ARCHIVE_DIR = path.join(ROOT, '_archive', 'post-essay')
const INDEX_FILE = path.join(ROOT, '_archive', 'post-essay-index.json')
const REFERER = 'https://www.3people.com.tw/'

async function main() {
  if (!fs.existsSync(CLASSIFIED)) {
    console.error('缺 _post-classified.json，請先跑 probe-post.js + _classify-post.js')
    process.exit(1)
  }
  const { rows } = JSON.parse(fs.readFileSync(CLASSIFIED, 'utf-8'))
  // 非選擇題卷（申論 / 計算 / 疑壞檔）= 專業職一、營運職的專業科目
  const essays = rows.filter(r => r.verdict !== '選擇題' && !String(r.verdict).startsWith('部分'))
  console.log(`封存 ${essays.length} 份申論／計算卷 → _archive/post-essay/\n`)

  const index = []
  let ok = 0, fail = 0
  for (const r of essays) {
    const dest = path.join(ARCHIVE_DIR, r.rel)
    index.push({ year: r.year, rank: r.rank, subject: r.subject, rel: r.rel, verdict: r.verdict, url: r.url })
    if (fs.existsSync(dest)) { ok++; continue }
    try {
      const buf = await cachedFetch(r.url, CACHE_DIR, { referer: REFERER, timeout: 45000 })
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, buf)
      ok++
    } catch (e) {
      fail++
      console.log(`  ✗ ${r.year} ${r.rank} ${r.subject}: ${e.message}`)
    }
    await new Promise(res => setTimeout(res, 60))
  }

  fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true })
  fs.writeFileSync(INDEX_FILE, JSON.stringify({
    note: '中華郵政專業職(一)/營運職 申論卷封存清單（不上線，僅備份）',
    archivedAt: new Date().toISOString(),
    total: index.length,
    papers: index,
  }, null, 2))

  // 統計
  const byRank = {}
  for (const e of index) byRank[e.rank] = (byRank[e.rank] || 0) + 1
  console.log(`\n完成：封存 ${ok} 份${fail ? `，失敗 ${fail} 份` : ''}`)
  console.log('  ' + Object.entries(byRank).map(([k, v]) => `${k}=${v}`).join('  '))
  console.log(`  索引 → _archive/post-essay-index.json`)
}

main().catch(e => { console.error(e); process.exit(1) })
