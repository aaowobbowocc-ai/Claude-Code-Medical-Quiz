#!/usr/bin/env node
/**
 * Scrape Taiwan public-health pages (CDC, HPA) into the RAG knowledge base.
 *
 * These are Taiwan government / public-domain content (公文書, 不受著作權法保護
 * 第 9 條第 1 項第 1 款). Safe to ingest and serve as RAG context.
 *
 * Strategy: ingest curated disease/topic URLs. Aggressively strip nav/footer
 * HTML — embedding-based retrieval is somewhat tolerant of leftover noise.
 */

require('dotenv/config')
const rag = require('../rag')

// Curated CDC Taiwan disease subindex pages. The SubIndex IDs are stable
// and each represents one infectious-disease topic.
const CDC_PAGES = [
  ['流行性斑疹傷寒',         '/Disease/SubIndex/-Bwx4k9nuXzv1znntQ-DhA'],
  ['新型A型流感',             '/Disease/SubIndex/0m_BXsu8AnI7slMt75OUaQ'],
  ['屈公病',                  '/Disease/SubIndex/1FYd5Fxevaam6xBazeiSRA'],
  ['念珠菌症',                '/Disease/SubIndex/1eaJi1denSmW8L3FD2Bybw'],
  ['麻疹',                    '/Disease/SubIndex/1s7E2BErloh0I3okXTYiuQ'],
  ['李斯特菌症',              '/Disease/SubIndex/1yyEHADlGlsJkqyjTMsf8w'],
  ['德國麻疹',                '/Disease/SubIndex/3DGpsvfGoSlTJyTGmn-pbw'],
  ['茲卡病毒感染症',          '/Disease/SubIndex/3RrXho4Rz3cqtHUGHpVVhw'],
  ['霍亂',                    '/Disease/SubIndex/3s96eguiLtdGQtgNv7Rk1g'],
  ['結核病',                  '/Disease/SubIndex/4Q2S4vQH2s5ECf9ciWEu9g'],
]

// Generic public-domain content URLs. Each entry: [title, url, source-tag]
const EXTRA_PAGES = [
  // (Reserved for future additions — HPA topics, MOHW guidelines, etc.)
]

const UA = { 'User-Agent': 'Mozilla/5.0 (TaiwanExamRAGBot)' }

async function fetchPage(url) {
  const resp = await fetch(url, { headers: UA })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return await resp.text()
}

// CDC pages have heavy chrome. Rather than parse the DOM, we slice between
// the "::: 回首頁" breadcrumb and the "更新時間" footer marker, then strip tags.
function extractCdcBody(html) {
  // Find the main content marker. CDC marks "::: 回首頁" right before nav,
  // and the disease content sits in a div with class containing "ContentArea"
  // or appears after "<main" tag.
  let body = html
  // Crude bounds: take everything after the first <main or ContentArea opening
  const mainStart = body.search(/<(?:main|article)\b[^>]*>|class="[^"]*(?:ContentArea|main-area|post-detail)/i)
  if (mainStart >= 0) body = body.slice(mainStart)
  const mainEnd = body.search(/<(?:footer|aside)\b/i)
  if (mainEnd > 1000) body = body.slice(0, mainEnd)

  return body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim()
}

async function ingestCdcPage(title, path, stats) {
  try {
    const url = `https://www.cdc.gov.tw${path}`
    const html = await fetchPage(url)
    const content = extractCdcBody(html)
    if (!content || content.length < 500) {
      console.log(`  ✗ ${title}: too short (${content?.length || 0} chars)`)
      stats.skipped++
      return
    }
    const result = await rag.ingestDocument({
      source:   'tw_cdc',
      url,
      title,
      language: 'zh',
      category: 'public-health',
      content:  content.slice(0, 30_000),
      metadata: {
        license:     'public-domain',
        attribution: '衛生福利部疾病管制署',
      },
    })
    if (result.skipped) {
      console.log(`  · ${title}: already ingested`)
      stats.alreadyIngested++
    } else {
      console.log(`  ✓ ${title}: ${result.chunks} chunks`)
      stats.ingested++
      stats.chunks += result.chunks
    }
  } catch (e) {
    console.log(`  ✗ ${title}: ${e.message}`)
    stats.failed++
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  const stats = { ingested: 0, alreadyIngested: 0, skipped: 0, failed: 0, chunks: 0 }
  console.log(`Ingesting ${CDC_PAGES.length} Taiwan CDC pages…\n`)
  for (let i = 0; i < CDC_PAGES.length; i++) {
    const [title, path] = CDC_PAGES[i]
    process.stdout.write(`[${i + 1}/${CDC_PAGES.length}] `)
    await ingestCdcPage(title, path, stats)
    await sleep(500)
  }
  console.log('\n--- summary ---')
  console.log(JSON.stringify(stats, null, 2))
}

main().catch(e => { console.error(e); process.exit(1) })
