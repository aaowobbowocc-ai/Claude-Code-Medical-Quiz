#!/usr/bin/env node
// civil-senior (高考三等 一般行政) 100-105 backfill.
// 100-105 用合併場次（高考+普考+初考），格式跟 106+ 不同（無 ABCD 標記），
// 用 column-aware parser. (code,c,s) 由 _civil-senior-100-105-full.json probe 確認。
// 缺：100/101 找不到合適 session；102 行政學/行政法 c/s 未明，需另 probe。
//
// Usage: node scripts/scrape-civil-senior-100-105.js [--dry-run] [--apply]

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { fetchPdf } = require('./lib/pdf-fetcher')
const { parseColumnAware, parseAnswersColumnAware } = require('./lib/moex-column-parser')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const OUT = path.join(__dirname, '..', 'questions-civil-senior.json')
const APPLY = process.argv.includes('--apply')
const DRY = process.argv.includes('--dry-run')

// Confirmed scrapable from probe (一般行政, 測驗題部分)
const TARGETS = [
  { year: '103', code: '103080', c: '201', s: '0101', subject: '國文（測驗）',    tag: 'chinese',                expectedQ: 10 },
  { year: '103', code: '103080', c: '201', s: '0401', subject: '行政學',          tag: 'admin_studies',          expectedQ: 25 },
  { year: '103', code: '103080', c: '201', s: '0503', subject: '行政法',          tag: 'admin_law',              expectedQ: 25 },
  { year: '104', code: '104080', c: '201', s: '0101', subject: '國文（測驗）',    tag: 'chinese',                expectedQ: 10 },
  { year: '104', code: '104080', c: '201', s: '0111', subject: '法學知識與英文',  tag: 'law_knowledge_english',  expectedQ: 50 },
  { year: '104', code: '104080', c: '201', s: '0503', subject: '行政法',          tag: 'admin_law',              expectedQ: 25 },
  { year: '105', code: '105080', c: '201', s: '0101', subject: '國文（測驗）',    tag: 'chinese',                expectedQ: 10 },
  { year: '105', code: '105080', c: '201', s: '0504', subject: '行政學',          tag: 'admin_studies',          expectedQ: 25 },
  { year: '105', code: '105080', c: '201', s: '0601', subject: '行政法',          tag: 'admin_law',              expectedQ: 25 },
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getPdf(t, code, c, s) {
  return fetchPdf(`${BASE}?t=${t}&code=${code}&c=${c}&s=${s}&q=1`)
}

async function main() {
  let data
  try { data = JSON.parse(fs.readFileSync(OUT, 'utf-8')) } catch { data = { total: 0, questions: [] } }
  const existingKey = new Set(data.questions.map(q => `${q.exam_code}_${q.number}_${q.subject_tag}`))
  let nextId = Math.max(0, ...data.questions.map(q => Number(q.id) || 0)) + 1
  const added = []

  for (const t of TARGETS) {
    console.log(`\n▶ ${t.year} ${t.subject} (${t.code} c=${t.c} s=${t.s})`)
    let qbuf, abuf
    try { qbuf = await getPdf('Q', t.code, t.c, t.s) } catch (e) { console.log(`  ✗ Q: ${e.message}`); continue }
    try { abuf = await getPdf('S', t.code, t.c, t.s) } catch (e) { console.log(`  ⚠ S: ${e.message}`); abuf = null }

    let parsed = {}
    try { parsed = await parseColumnAware(qbuf) } catch (e) { console.log(`  ✗ parse: ${e.message}`); continue }
    let answers = {}
    if (abuf) {
      try { answers = await parseAnswersColumnAware(abuf) } catch (e) { console.log(`  ⚠ ans parse: ${e.message}`) }
    }

    const nums = Object.keys(parsed).map(Number).sort((a, b) => a - b)
    console.log(`  parsed ${nums.length} Q / ${Object.keys(answers).length} A (expected ${t.expectedQ})`)

    let n = 0
    for (const num of nums) {
      const q = parsed[num]
      const ans = answers[num]
      if (!ans || !/^[ABCD]$/.test(ans)) continue
      if (!q.question || !q.options || ['A','B','C','D'].some(k => !q.options[k])) continue
      const key = `${t.code}_${num}_${t.tag}`
      if (existingKey.has(key)) continue
      added.push({
        id: nextId++, roc_year: t.year, session: '第一次', exam_code: t.code,
        subject: t.subject, subject_tag: t.tag, subject_name: t.subject,
        stage_id: 0, number: num, question: q.question, options: q.options,
        answer: ans, explanation: '',
      })
      existingKey.add(key); n++
    }
    console.log(`  + ${n} new`)
    await sleep(300)
  }

  console.log(`\n總新增 ${added.length}`)
  if (added.length === 0) return
  if (DRY) { console.log('(dry-run)'); return }
  if (!APPLY) { console.log('(no --apply; not writing)'); return }
  data.questions.push(...added)
  data.total = data.questions.length
  const tmp = OUT + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, OUT)
  console.log(`✅ wrote ${OUT}, total ${data.total}`)
}
main().catch(e => { console.error(e); process.exit(1) })
