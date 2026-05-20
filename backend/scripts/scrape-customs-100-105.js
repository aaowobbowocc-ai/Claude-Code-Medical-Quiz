#!/usr/bin/env node
// customs (關務特考) 100-105 backfill — column-aware parser for 100-105 format.
// (code,c,s) verified by deep probe 2026-05-20.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { fetchPdf } = require('./lib/pdf-fetcher')
const { parseColumnAware, parseAnswersColumnAware } = require('./lib/moex-column-parser')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const OUT = path.join(__dirname, '..', 'questions-customs.json')
const APPLY = process.argv.includes('--apply')

// (year, code, c, s, subject, subject_tag, expectedQ)
const TARGETS = [
  ['103', '103050', '101', '0101', '國文（測驗）',  'chinese',       10],
  ['103', '103050', '101', '0103', '英文',          'english',       50],
  ['104', '104050', '101', '0101', '國文（測驗）',  'chinese',       10],
  ['104', '104050', '101', '0201', '英文',          'english',       50],
  ['104', '104050', '101', '0312', '法學知識',      'law_knowledge', 30],
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const data = JSON.parse(fs.readFileSync(OUT, 'utf-8'))
  const qs = data.questions || data
  const existingKey = new Set(qs.map(q => `${q.exam_code}_${q.number}_${q.subject_tag}`))
  let nextId = Math.max(0, ...qs.map(q => Number(q.id) || 0)) + 1
  const added = []
  for (const [year, code, c, s, subject, tag, expQ] of TARGETS) {
    console.log(`\n▶ ${year} ${subject} (${code} c=${c} s=${s})`)
    let qbuf, abuf
    try { qbuf = await fetchPdf(`${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`) } catch (e) { console.log(`  ✗ Q: ${e.message}`); continue }
    try { abuf = await fetchPdf(`${BASE}?t=S&code=${code}&c=${c}&s=${s}&q=1`) } catch (e) { console.log(`  ⚠ S: ${e.message}`); abuf = null }
    let parsed = {}
    try { parsed = await parseColumnAware(qbuf) } catch (e) { console.log(`  ✗ parse: ${e.message}`); continue }
    let answers = {}
    if (abuf) { try { answers = await parseAnswersColumnAware(abuf) } catch {} }
    const nums = Object.keys(parsed).map(Number).sort((a, b) => a - b)
    console.log(`  parsed ${nums.length} Q / ${Object.keys(answers).length} A (expected ${expQ})`)
    let n = 0
    for (const num of nums) {
      const q = parsed[num]
      const ans = answers[num]
      if (!ans || !/^[ABCD]$/.test(ans)) continue
      if (!q.question || !q.options || ['A','B','C','D'].some(k => !q.options[k])) continue
      const key = `${code}_${num}_${tag}`
      if (existingKey.has(key)) continue
      added.push({
        id: nextId++, roc_year: year, session: '第一次', exam_code: code,
        subject, subject_tag: tag, subject_name: subject,
        stage_id: 0, number: num, question: q.question, options: q.options,
        answer: ans, explanation: '',
      })
      existingKey.add(key); n++
    }
    console.log(`  + ${n} new`)
    await sleep(250)
  }
  console.log(`\n總新增 ${added.length}`)
  if (added.length && APPLY) {
    qs.push(...added)
    data.questions = qs; data.total = qs.length
    const tmp = OUT + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, OUT)
    console.log(`✅ wrote ${OUT}, total ${data.total}`)
  } else if (!APPLY) console.log('(no --apply)')
}
main().catch(e => { console.error(e); process.exit(1) })
