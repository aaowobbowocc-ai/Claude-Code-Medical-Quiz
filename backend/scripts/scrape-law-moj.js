#!/usr/bin/env node
/**
 * Ingest 中華民國法規（全國法規資料庫 ChLaw.json）→ RAG。
 *
 * 用 bulk OpenData JSON：
 *   curl https://law.moj.gov.tw/api/Ch/Law/JSON -o ChLaw.zip
 *   unzip ChLaw.zip → backend/_tmp/ChLaw.json
 *
 * 每一「條」（ArticleType=A、有 ArticleNo）當作一篇 document。
 *
 * 相關考試：lawyer1, judicial, civil-senior, customs, police, police4
 *
 * Usage:
 *   node scripts/scrape-law-moj.js --dry-run        # 看 target 數
 *   node scripts/scrape-law-moj.js --law=憲法        # 只跑某部
 *   node scripts/scrape-law-moj.js                   # 全跑
 */
require('dotenv/config')
const fs = require('fs')
const path = require('path')
const rag = require('../rag')

const DATA_FILE = path.join(__dirname, '..', '_tmp', 'ChLaw.json')

// 目標法規清單 — 依考試科目挑選
const TARGET_LAWS = [
  // 憲法
  '中華民國憲法',
  '中華民國憲法增修條文',

  // 民法系
  '民法',
  '民法總則施行法',
  '民法債編施行法',
  '民法物權編施行法',
  '民法親屬編施行法',
  '民法繼承編施行法',
  '民事訴訟法',
  '強制執行法',
  '家事事件法',

  // 刑法系
  '中華民國刑法',
  '刑法施行法',
  '刑事訴訟法',
  '刑事訴訟法施行法',
  '少年事件處理法',

  // 行政法系
  '行政程序法',
  '行政罰法',
  '行政訴訟法',
  '訴願法',
  '國家賠償法',
  '中央法規標準法',
  '公務員服務法',
  '公務人員任用法',
  '公務人員考試法',
  '公務人員保障法',

  // 商事法
  '公司法',
  '證券交易法',
  '票據法',
  '保險法',
  '海商法',

  // 稅法
  '稅捐稽徵法',
  '所得稅法',
  '加值型及非加值型營業稅法',
  '遺產及贈與稅法',

  // 關務（關務特考用）
  '海關緝私條例',
  '關稅法',

  // 警察（警察特考用）
  '警察法',
  '警察職權行使法',
  '社會秩序維護法',
  '集會遊行法',

  // 道路交通（駕照考試用）
  '道路交通管理處罰條例',
  '道路交通安全規則',

  // 智財權（律師選考）
  '著作權法',
  '商標法',
  '專利法',

  // 勞動
  '勞動基準法',
  '勞工保險條例',
]

function loadLaws() {
  const raw = fs.readFileSync(DATA_FILE, 'utf8').replace(/^﻿/, '')
  const data = JSON.parse(raw)
  return data.Laws
}

function articleToDocument(law, art) {
  const articleNo = (art.ArticleNo || '').trim()
  const content = (art.ArticleContent || '').trim()
  if (!articleNo || !content || content.length < 10) return null

  // ArticleType: A = 條文, C = 章節標題（跳過）
  if (art.ArticleType !== 'A') return null

  const articleTitle = `${law.LawName} ${articleNo}`
  // FLNO format: e.g. "第 1 條" → "1", "第 1-1 條" → "1-1"
  const flno = articleNo.replace(/^第\s*/, '').replace(/\s*條$/, '').replace(/\s+/g, '')
  const url = `${law.LawURL}#article-${encodeURIComponent(flno)}`

  return {
    source: 'law_moj_tw',
    url,
    title: articleTitle,
    language: 'zh',
    category: law.LawCategory || law.LawLevel || '法規',
    content: `${articleTitle}\n${content}`,
    metadata: {
      law_name: law.LawName,
      law_url: law.LawURL,
      law_category: law.LawCategory,
      law_level: law.LawLevel,
      article_no: articleNo,
      attribution: '全國法規資料庫（法務部）',
      license: '政府公開資料',
    },
  }
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const lawFilter = args.find(a => a.startsWith('--law='))?.split('=')[1]
  const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1]) || Infinity

  console.log(`[scrape-law-moj] dry=${dryRun} filter=${lawFilter || 'all targets'}`)

  if (!fs.existsSync(DATA_FILE)) {
    console.error(`Missing ${DATA_FILE}. Run:`)
    console.error(`  curl -sL https://law.moj.gov.tw/api/Ch/Law/JSON -o backend/_tmp/ChLaw.zip && cd backend/_tmp && unzip -o ChLaw.zip`)
    process.exit(1)
  }

  const allLaws = loadLaws()
  console.log(`Total laws in dataset: ${allLaws.length}`)

  let targetLaws = allLaws.filter(l => TARGET_LAWS.includes(l.LawName))
  if (lawFilter) targetLaws = targetLaws.filter(l => l.LawName.includes(lawFilter))

  console.log(`Target laws: ${targetLaws.length}/${TARGET_LAWS.length}`)
  for (const l of targetLaws) {
    const arts = (l.LawArticles || []).filter(a => a.ArticleType === 'A' && a.ArticleNo)
    console.log(`  ${l.LawName.padEnd(20)} → ${arts.length} articles`)
  }

  if (dryRun) {
    const totalArts = targetLaws.reduce((a, l) =>
      a + (l.LawArticles || []).filter(a => a.ArticleType === 'A' && a.ArticleNo).length, 0)
    console.log(`\n[dry-run] Total articles to ingest: ${totalArts}`)
    console.log(`Estimated time: ~${Math.ceil(totalArts / 50 * 5)} sec at 50 chunks/5sec batch rate`)
    return
  }

  const stats = { ingested: 0, skipped: 0, failed: 0, chunks: 0 }
  let processed = 0

  for (const law of targetLaws) {
    console.log(`\n=== ${law.LawName} ===`)
    const articles = (law.LawArticles || []).filter(a => a.ArticleType === 'A' && a.ArticleNo)

    for (const art of articles) {
      if (processed >= limit) break
      const doc = articleToDocument(law, art)
      if (!doc) { stats.skipped++; continue }
      try {
        const r = await rag.ingestDocument(doc)
        if (r.skipped) stats.skipped++
        else { stats.ingested++; stats.chunks += r.chunks }
      } catch (e) {
        stats.failed++
        if (stats.failed <= 5) console.log(`  ✗ ${art.ArticleNo}: ${e.message}`)
      }
      processed++
      if (processed % 50 === 0) {
        process.stdout.write(`\r  ${processed} processed, ${stats.ingested} new, ${stats.skipped} skip, ${stats.chunks} chunks`)
      }
    }
    if (processed >= limit) break
  }

  console.log(`\n\n=== STATS ===`)
  console.log(`  Ingested: ${stats.ingested}`)
  console.log(`  Skipped:  ${stats.skipped} (already in DB)`)
  console.log(`  Failed:   ${stats.failed}`)
  console.log(`  Chunks:   ${stats.chunks}`)
}

main().catch(e => { console.error(e); process.exit(1) })
