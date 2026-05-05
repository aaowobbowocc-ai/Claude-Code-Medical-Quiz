#!/usr/bin/env node
/**
 * Scrape Chinese Wikipedia medical articles into the RAG knowledge base.
 *
 * Wikipedia content is CC BY-SA 3.0 / 4.0 — commercial use OK with attribution
 * (we keep `metadata.attribution` on each chunk).
 *
 * Two modes:
 *   --seeds   ingest the curated TAIWAN_EXAM_SEEDS list (~150 high-yield topics)
 *   --category=NAME  recursively crawl a Wikipedia category (e.g. "藥物")
 */

require('dotenv/config')
const rag = require('../rag')

const WIKI_API = 'https://zh.wikipedia.org/w/api.php'

// Curated list of Taiwan-medical-exam-relevant topics. Keep concise — RAG
// works better with focused authoritative content than scraping the whole
// medicine category tree.
const TAIWAN_EXAM_SEEDS = [
  // 心血管
  '高血壓', '心肌梗塞', '心臟衰竭', '心房顫動', '心律不整', '主動脈剝離', '心包填塞',
  '深部靜脈血栓', '肺栓塞',
  // 內分泌
  '糖尿病', '甲狀腺功能亢進症', '甲狀腺功能低下症', '庫欣氏症候群', '艾迪生氏病',
  // 腎臟
  '慢性腎臟病', '急性腎損傷', '腎絲球腎炎', '腎病症候群', '尿路結石',
  // 消化
  '肝硬化', 'B型肝炎', 'C型肝炎', '消化性潰瘍', '克隆氏症', '潰瘍性結腸炎', '大腸直腸癌',
  '胰臟炎', '膽結石',
  // 呼吸
  '肺炎', '結核病', '氣喘', '慢性阻塞性肺病', '肺癌', '肺纖維化',
  // 神經
  '中風', '腦中風', '帕金森氏症', '阿茲海默症', '癲癇', '多發性硬化症', '重症肌無力',
  '蜘蛛網膜下腔出血',
  // 感染
  '敗血症', '心內膜炎', '尿路感染', '腦膜炎', 'HIV', '愛滋病', '梅毒', '淋病',
  // 血液
  '貧血', '缺鐵性貧血', '白血病', '淋巴瘤', '多發性骨髓瘤', '彌散性血管內凝血',
  // 免疫風濕
  '紅斑性狼瘡', '類風濕性關節炎', '僵直性脊椎炎', '痛風',
  // 婦產
  '子宮頸癌', '乳癌', '子宮內膜癌', '卵巢癌', '子癇前症',
  // 兒科
  '川崎氏病', '腸病毒', '麻疹', '德國麻疹', '水痘', '腮腺炎',
  // 精神
  '憂鬱症', '思覺失調症', '雙相情緒障礙症', '焦慮症',
  // 影像/檢驗
  '心電圖', '電腦斷層掃描', '磁振造影',
  // 藥物機轉
  'ACE抑制劑', '鈣離子通道阻斷劑', '乙型阻斷劑', '利尿劑', '抗凝血劑', '抗生素',
  '非類固醇消炎藥', '皮質類固醇', '降血糖藥', '胰島素', 'Statin', 'Aspirin',
  // 解剖/生理基礎
  '心臟', '肺臟', '肝臟', '腎臟', '腦', '神經系統', '消化系統', '免疫系統',
  // 微生物常考
  '金黃色葡萄球菌', '大腸桿菌', '肺炎鏈球菌', '結核桿菌', '人類免疫缺陷病毒', '流感病毒',
  // 生化
  '糖解作用', '檸檬酸循環', 'DNA複製', '蛋白質合成',
  // 病理基礎
  '發炎反應', '凋亡', '腫瘤',
]

async function fetchWikiArticle(title) {
  const params = new URLSearchParams({
    action:        'query',
    format:        'json',
    prop:          'extracts|info|categories',
    titles:        title,
    explaintext:   '1',
    exsectionformat: 'plain',
    inprop:        'url',
    redirects:     '1',
    formatversion: '2',
  })
  const resp = await fetch(`${WIKI_API}?${params}`, {
    headers: { 'User-Agent': 'TaiwanExamRAGBot/1.0 (https://yourdomain.example)' },
  })
  if (!resp.ok) throw new Error(`wiki fetch ${title}: HTTP ${resp.statusCode || resp.status}`)
  const data = await resp.json()
  const page = data.query?.pages?.[0]
  if (!page || page.missing) return null
  if (!page.extract || page.extract.length < 200) return null  // skip stubs
  return {
    title:    page.title,
    url:      page.fullurl,
    content:  page.extract,
    category: page.categories?.[0]?.title?.replace(/^Category:/, '') || 'medicine',
  }
}

async function ingestSeed(title, stats) {
  try {
    const article = await fetchWikiArticle(title)
    if (!article) {
      console.log(`  ✗ ${title}: not found / too short`)
      stats.skipped++
      return
    }
    const result = await rag.ingestDocument({
      source:   'wikipedia_zh',
      url:      article.url,
      title:    article.title,
      language: 'zh',
      category: article.category,
      content:  article.content,
      metadata: { license: 'CC-BY-SA-4.0', attribution: 'Wikipedia 中文' },
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

// Polite rate-limit: 2 req/sec cap to be a good Wikipedia citizen.
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function processSeeds(seeds) {
  const stats = { ingested: 0, alreadyIngested: 0, skipped: 0, failed: 0, chunks: 0 }
  for (let i = 0; i < seeds.length; i++) {
    const t = seeds[i]
    process.stdout.write(`[${i + 1}/${seeds.length}] `)
    await ingestSeed(t, stats)
    await sleep(500)
  }
  console.log('\n--- summary ---')
  console.log(JSON.stringify(stats, null, 2))
}

async function main() {
  const seedsArg = process.argv.includes('--seeds')
  const limitArg = process.argv.find(a => a.startsWith('--limit='))?.slice(8)
  const limit = limitArg ? parseInt(limitArg) : 0

  const seeds = limit ? TAIWAN_EXAM_SEEDS.slice(0, limit) : TAIWAN_EXAM_SEEDS
  if (seedsArg || !process.argv.slice(2).find(a => a.startsWith('--category'))) {
    console.log(`Ingesting ${seeds.length} seed topics from Chinese Wikipedia…\n`)
    await processSeeds(seeds)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
