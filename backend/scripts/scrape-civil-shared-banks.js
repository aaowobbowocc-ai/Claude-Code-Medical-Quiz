#!/usr/bin/env node
// Batch scraper for civil-service shared banks.
// Expands common_law_knowledge (junior) and common_law_basics (elementary)
// by scraping 普通考試 and 初等考試 for 106–113 年.
//
// Usage:
//   node scripts/scrape-civil-shared-banks.js                 # all pending
//   node scripts/scrape-civil-shared-banks.js --dry-run
//   node scripts/scrape-civil-shared-banks.js --bank law_knowledge
//   node scripts/scrape-civil-shared-banks.js --bank law_basics
//   node scripts/scrape-civil-shared-banks.js --year 111

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const { execFile } = require('child_process')
const path = require('path')
const fs = require('fs')

const SCRAPER = path.join(__dirname, 'scrape-moex.js')
const BANKS_DIR = path.join(__dirname, '..', 'shared-banks')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const bankFilter = args.find((_, i) => args[i - 1] === '--bank') || null
const yearFilter = args.find((_, i) => args[i - 1] === '--year') || null

// ─── Session definitions ───
// common_law_knowledge: 普通考試（四等）法學知識與英文（各類科）c=401
const LAW_KNOWLEDGE_SESSIONS = [
  { year: '106', code: '106090', c: '401', s: '0211' },
  { year: '107', code: '107090', c: '401', s: '0211' },
  { year: '108', code: '108090', c: '401', s: '0214' },
  { year: '109', code: '109090', c: '401', s: '0217' },
  { year: '110', code: '110090', c: '401', s: '0106' },
  { year: '111', code: '111090', c: '401', s: '0116' },
  { year: '112', code: '112090', c: '401', s: '0119' },
  { year: '113', code: '113080', c: '401', s: '0113' },
  // 114 already scraped
  // 地特 114 三等/五等 + 原民 112/113 四等 + 高考 114 c=203（法學知識與英文共同科目，可加入 shared bank）
  { year: '114', code: '114160', c: '101', s: '0105', level: 'senior',
    sourceName: '114 年地方特考三等一般行政', sourceCode: 'civil-local-senior' },
  { year: '114', code: '114160', c: '501', s: '0106', level: 'elementary',
    sourceName: '114 年地方特考五等一般行政', sourceCode: 'civil-local-elementary' },
  { year: '112', code: '112090', c: '311', s: '0118', level: 'junior',
    sourceName: '112 年原住民族特考四等', sourceCode: 'civil-indigenous-junior' },
  { year: '113', code: '113080', c: '311', s: '0112', level: 'junior',
    sourceName: '113 年原住民族特考四等', sourceCode: 'civil-indigenous-junior' },
  { year: '114', code: '114080', c: '203', s: '0401', level: 'senior',
    sourceName: '114 年高考三等客家事務行政', sourceCode: 'civil-senior-hakka' },
  // 地特三等/五等 112-113（四等不共用 法學知識與英文；s code 沿用 114 的 0105/0106 模式）
  { year: '112', code: '112160', c: '101', s: '0119', level: 'senior',
    sourceName: '112 年地方特考三等一般行政', sourceCode: 'civil-local-senior' },
  { year: '113', code: '113160', c: '101', s: '0113', level: 'senior',
    sourceName: '113 年地方特考三等一般行政', sourceCode: 'civil-local-senior' },
  { year: '112', code: '112160', c: '501', s: '0119', level: 'elementary',
    sourceName: '112 年地方特考五等一般行政', sourceCode: 'civil-local-elementary' },
  { year: '113', code: '113160', c: '501', s: '0113', level: 'elementary',
    sourceName: '113 年地方特考五等一般行政', sourceCode: 'civil-local-elementary' },
  // 教育行政高考三等 113 (c=111)
  { year: '113', code: '113080', c: '111', s: '0401', level: 'senior',
    sourceName: '113 年高考三等教育行政', sourceCode: 'civil-senior-education' },
]

// common_law_basics: 初等考試（五等）法學大意（一般行政等）c=501
const LAW_BASICS_SESSIONS = [
  { year: '106', code: '106010', c: '501', s: '0201' }, // older code
  { year: '107', code: '107010', c: '501', s: '0202' },
  { year: '108', code: '108010', c: '501', s: '0202' },
  { year: '109', code: '109010', c: '501', s: '0202' },
  { year: '110', code: '110010', c: '501', s: '0202' },
  { year: '111', code: '111010', c: '501', s: '0202' },
  { year: '112', code: '112010', c: '501', s: '0202' },
  { year: '113', code: '113010', c: '501', s: '0202' },
  // 114 already scraped
]

function getExistingIds(bankId) {
  const p = path.join(BANKS_DIR, bankId + '.json')
  if (!fs.existsSync(p)) return new Set()
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf-8'))
    return new Set((d.questions || []).map(q => q.id))
  } catch { return new Set() }
}

function runScraper(scrapeArgs) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [SCRAPER, ...scrapeArgs], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env },
      timeout: 120000,
    })
    child.stdout.on('data', d => process.stdout.write(d))
    child.stderr.on('data', d => process.stderr.write(d))
    child.on('close', code => code === 0 ? resolve() : reject(new Error('exit ' + code)))
  })
}

async function main() {
  const tasks = []

  if (!bankFilter || bankFilter === 'law_knowledge') {
    for (const s of LAW_KNOWLEDGE_SESSIONS) {
      if (yearFilter && s.year !== yearFilter) continue
      tasks.push({
        bank: 'common_law_knowledge',
        level: s.level || 'junior',
        year: s.year,
        code: s.code,
        c: s.c,
        subj: s.s,
        sourceName: s.sourceName || `${s.year} 年普通考試一般行政`,
        sourceCode: s.sourceCode || 'civil-junior-general',
        paper: '法學知識與英文（包括中華民國憲法、法學緒論、英文）',
        tags: 'law_knowledge_combined',
      })
    }
  }

  if (!bankFilter || bankFilter === 'law_basics') {
    for (const s of LAW_BASICS_SESSIONS) {
      if (yearFilter && s.year !== yearFilter) continue
      tasks.push({
        bank: 'common_law_basics',
        level: 'elementary',
        year: s.year,
        code: s.code,
        c: s.c,
        subj: s.s,
        sourceName: `${s.year} 年初等考試一般行政`,
        sourceCode: 'civil-elementary-general',
        paper: '法學大意',
        tags: 'law_basics',
      })
    }
  }

  console.log(`\n📋 ${tasks.length} sessions to scrape${dryRun ? ' (dry-run)' : ''}`)

  let ok = 0, skip = 0, fail = 0
  for (const t of tasks) {
    // Skip if all questions for this year already exist in the bank
    const ids = getExistingIds(t.bank)
    const sampleId = `${t.bank}-${t.year}-${t.sourceCode}-1`
    if (!dryRun && ids.has(sampleId)) {
      console.log(`  ⏭ ${t.bank} ${t.year} already present`)
      skip++
      continue
    }

    console.log(`\n▶ ${t.bank} ${t.year} (${t.code} c=${t.c} s=${t.subj})`)
    const scrapeArgs = [
      '--shared-bank', t.bank,
      '--level', t.level,
      '--source-exam-name', t.sourceName,
      '--source-exam-code', t.sourceCode,
      '--moex-code', t.code,
      '--moex-class', t.c,
      '--moex-subject', t.subj,
      '--paper', t.paper,
      '--year', t.year,
      '--subject-tags', t.tags,
      ...(dryRun ? ['--dry-run'] : []),
    ]

    try {
      await runScraper(scrapeArgs)
      ok++
    } catch (e) {
      console.error(`  ✗ Failed: ${e.message}`)
      fail++
    }
    // Polite delay between requests
    if (!dryRun) await new Promise(r => setTimeout(r, 800))
  }

  console.log(`\n✅ Done: ${ok} ok, ${skip} skipped, ${fail} failed`)
}

main().catch(e => { console.error(e); process.exit(1) })
