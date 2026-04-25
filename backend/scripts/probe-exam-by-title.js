#!/usr/bin/env node
/**
 * Brute-force probe MoEX PDFs and validate by PDF title.
 *
 * Why: c/s codes change year-to-year. Hard-coding per-year mappings is
 * brittle. Instead: scan c×s ranges, fetch each, check PDF header for
 * exam name keyword.
 *
 * Usage:
 *   node scripts/probe-exam-by-title.js --keyword 聽力師 --years 114,115
 *   node scripts/probe-exam-by-title.js --keyword 語言治療師 --years 111,112,113
 *   node scripts/probe-exam-by-title.js --keyword 公共衛生師 --years 113,114
 *
 * Options:
 *   --keyword <str>    Exam name to find (e.g. 聽力師, 語言治療師)
 *   --years <list>     Comma-separated years (e.g. 111,112,113)
 *   --sessions <list>  Suffix list (default: 010,020,030,090,100,110,140)
 *   --c-range <a-b>    Class code range (default: 101-120)
 *   --s-list <list>    Subject code list (default: 0101-0106,0201-0206,...,0901-0906)
 *   --concurrency <n>  Parallel HTTP requests (default: 5)
 */
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

const args = process.argv.slice(2)
const getArg = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : def
}

const KEYWORD = getArg('--keyword')
if (!KEYWORD) { console.error('--keyword required'); process.exit(1) }
const YEARS = getArg('--years', '111,112,113,114,115').split(',')
const SESSIONS = getArg('--sessions', '010,020,030,090,100,110,140').split(',')
const C_RANGE = getArg('--c-range', '101-120').split('-').map(Number)
const S_LIST = (getArg('--s-list', null) || (() => {
  // Default: all combinations of {01-09}{01-06}, e.g. 0101-0906
  const out = []
  for (let g = 1; g <= 9; g++) {
    for (let p = 1; p <= 6; p++) {
      out.push('0' + g + '0' + p)  // 0101, 0102, ..., 0906
    }
  }
  return out.join(',')
})()).split(',')
const CONCURRENCY = parseInt(getArg('--concurrency', '5'))

const CACHE = path.join(__dirname, '..', '_tmp', 'probe-cache')
fs.mkdirSync(CACHE, { recursive: true })

function fetchBuf(url, retries = 1) {
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({ rejectUnauthorized: false })
    const req = https.get(url, { agent, timeout: 8000 }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) { res.resume(); return reject(new Error('redirect')) }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', e => retries > 0 ? fetchBuf(url, retries - 1).then(resolve, reject) : reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function probeOne(code, c, s) {
  const key = code + '_c' + c + '_s' + s
  const cacheFile = path.join(CACHE, key + '.txt')
  // Cache HEADER text (first 300 chars) only — never store full PDFs blindly
  if (fs.existsSync(cacheFile)) {
    const head = fs.readFileSync(cacheFile, 'utf8')
    if (head.startsWith('NOT_FOUND')) return null
    return { code, c, s, head }
  }
  try {
    const url = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=Q&code=' + code + '&c=' + c + '&s=' + s + '&q=1'
    const buf = await fetchBuf(url)
    const { text } = await pdfParse(buf)
    const head = text.slice(0, 400)
    fs.writeFileSync(cacheFile, head)
    return { code, c, s, head, buf }
  } catch (e) {
    fs.writeFileSync(cacheFile, 'NOT_FOUND ' + e.message)
    return null
  }
}

async function runConcurrent(items, fn, concurrency) {
  const results = []
  let idx = 0
  async function worker() {
    while (idx < items.length) {
      const i = idx++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return results
}

;(async () => {
  console.log('Brute-force probe for keyword: ' + KEYWORD)
  console.log('Years: ' + YEARS.join(', '))
  console.log('Sessions: ' + SESSIONS.join(', '))
  console.log('c range: ' + C_RANGE[0] + '-' + C_RANGE[1])
  console.log('s list: ' + S_LIST.length + ' subject codes')
  console.log()

  const matches = []

  for (const yr of YEARS) {
    console.log('=== Year ' + yr + ' ===')
    for (const sfx of SESSIONS) {
      const code = yr + sfx
      const tasks = []
      for (let c = C_RANGE[0]; c <= C_RANGE[1]; c++) {
        for (const s of S_LIST) tasks.push({ c, s })
      }
      const results = await runConcurrent(tasks, async ({ c, s }) => probeOne(code, c, s), CONCURRENCY)
      const hits = results.filter(r => r && (
        new RegExp('類\\s{0,3}科[名稱\\s]*[：:]\\s*' + KEYWORD).test(r.head) ||
        r.head.includes('類科：' + KEYWORD) ||
        r.head.includes('類科名稱：' + KEYWORD)
      ))
      if (hits.length) {
        console.log('  ✓ ' + code + ' → ' + hits.length + ' subjects matched')
        for (const h of hits) {
          const subj = h.head.match(/科\s{0,3}目[名稱\s]*[：:][^\n]{0,40}/)
          const subjName = subj ? subj[0].replace(/科\s*目\s*[名稱\s]*[：:]\s*/, '').trim() : '(unknown)'
          console.log('     c=' + h.c + ' s=' + h.s + ' | ' + subjName)
          matches.push({ year: yr, code, c: h.c, s: h.s, subject: subjName })
        }
      }
    }
  }

  // Save final summary
  const out = path.join(__dirname, '..', '_tmp', 'probe-' + KEYWORD + '.json')
  fs.writeFileSync(out, JSON.stringify(matches, null, 2))
  console.log('\n==> ' + matches.length + ' matches saved to ' + path.basename(out))
})()
