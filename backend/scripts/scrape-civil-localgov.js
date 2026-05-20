#!/usr/bin/env node
// Scrape 普通考試（四等）一般民政「地方自治概要」測驗題部分 into common_local_gov.
// Mixed 申論+測驗 paper; scrape-moex.js skips 申論 and grabs the MCQ section.
// (code,c,s) verified by probing MoEX 2026-05-19. 普考 一般民政 = c=402.
//
// Usage:
//   node scripts/scrape-civil-localgov.js [--year 113] [--dry-run]

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const { execFile } = require('child_process')
const path = require('path')

const SCRAPER = path.join(__dirname, 'scrape-moex.js')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const yearFilter = args.find((_, i) => args[i - 1] === '--year') || null

const SESSIONS = [
  { year: '106', code: '106090', s: '0509' },
  { year: '107', code: '107090', s: '0612' },
  { year: '108', code: '108090', s: '0612' },
  { year: '109', code: '109090', s: '0609' },
  { year: '110', code: '110090', s: '0509' },
  { year: '111', code: '111090', s: '0309' },
  { year: '112', code: '112090', s: '0310' },
  { year: '113', code: '113080', s: '0307' },
  { year: '114', code: '114080', s: '0307' },
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
  let ok = 0, fail = 0
  for (const s of SESSIONS) {
    if (yearFilter && s.year !== yearFilter) continue
    console.log(`\n▶ 地方自治概要 ${s.year} (${s.code} c=402 s=${s.s})`)
    const scrapeArgs = [
      '--shared-bank', 'common_local_gov',
      '--level', 'junior',
      '--source-exam-name', `${s.year} 年普通考試一般民政`,
      '--source-exam-code', 'civil-junior-civil-affairs',
      '--moex-code', s.code,
      '--moex-class', '402',
      '--moex-subject', s.s,
      '--paper', '地方自治概要',
      '--year', s.year,
      '--subject-tags', 'local_gov',
      ...(dryRun ? ['--dry-run'] : []),
    ]
    try {
      await runScraper(scrapeArgs)
      ok++
    } catch (e) {
      console.error(`  ✗ Failed: ${e.message}`)
      fail++
    }
    if (!dryRun) await new Promise(r => setTimeout(r, 800))
  }
  console.log(`\n✅ Done: ${ok} ok, ${fail} failed`)
}

main().catch(e => { console.error(e); process.exit(1) })
