#!/usr/bin/env node
// 普考 一般行政 100-105 backfill. Targets:
//   common_admin_studies_junior  行政學概要 102-105
//   common_politics              政治學概要 102-105
//   common_admin_law_junior      行政法概要 105 (102-104 為申論)
//   common_local_gov             地方自治概要 (普考一般民政 c=402) 102-105 — probe needed first
// (code,c,s) verified by probe 2026-05-20.
//
// Usage: node scripts/scrape-civil-junior-100-105.js [--dry-run]

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const { execFile } = require('child_process')
const path = require('path')

const SCRAPER = path.join(__dirname, 'scrape-moex.js')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

// [bank, level, source-code, source-name-fn, tag, paper, year, code, c, s]
const TARGETS = [
  // 行政學概要 (junior 一般行政 c=401)
  ['common_admin_studies_junior', '行政學概要', 'admin_studies', [
    ['102', '102090', '401', '0402'],
    ['103', '103080', '401', '0402'],
    ['104', '104080', '401', '0402'],
    ['105', '105080', '401', '0505'],
  ]],
  // 政治學概要
  ['common_politics', '政治學概要', 'politics', [
    ['102', '102090', '401', '0407'],
    ['103', '103080', '401', '0407'],
    ['104', '104080', '401', '0407'],
    ['105', '105080', '401', '0507'],
  ]],
  // 行政法概要 (only 105 found MCQ in c=401)
  ['common_admin_law_junior', '行政法概要', 'admin_law', [
    ['105', '105080', '401', '0605'],
  ]],
]

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
  for (const [bank, paper, tag, sessions] of TARGETS) {
    for (const [year, code, c, s] of sessions) {
      console.log(`\n▶ ${bank} ${year} ${paper} (${code} c=${c} s=${s})`)
      const scrapeArgs = [
        '--shared-bank', bank,
        '--level', 'junior',
        '--source-exam-name', `${year} 年普通考試一般行政`,
        '--source-exam-code', 'civil-junior-general',
        '--moex-code', code,
        '--moex-class', c,
        '--moex-subject', s,
        '--paper', paper,
        '--year', year,
        '--subject-tags', tag,
        ...(dryRun ? ['--dry-run'] : []),
      ]
      try { await runScraper(scrapeArgs) }
      catch (e) { console.error(`  ✗ Failed: ${e.message}`) }
      if (!dryRun) await new Promise(r => setTimeout(r, 600))
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
