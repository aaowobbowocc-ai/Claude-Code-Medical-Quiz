#!/usr/bin/env node
// Scan all questions-*.json for missing question numbers per (year, session, subject).
// Usage: node scripts/find-gaps.js [examId]
//   examId optional — if given, only that exam (e.g. "nutrition")

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const onlyExam = process.argv[2] || null

const files = fs.readdirSync(ROOT)
  .filter(f => /^questions(-[a-z0-9]+)?\.json$/.test(f))
  .sort()

const PDF_BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

function examIdFromFile(f) {
  const m = f.match(/^questions-([a-z0-9]+)\.json$/)
  return m ? m[1] : 'doctor1'
}

const allGaps = []

for (const f of files) {
  const exam = examIdFromFile(f)
  if (onlyExam && exam !== onlyExam) continue

  const j = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'))
  const qs = j.questions || j
  if (!Array.isArray(qs)) continue

  // group by year|session|subject (= paper, not 細科 subject_name)
  const groups = new Map()
  for (const q of qs) {
    const subj = q.subject || '(unknown)'
    const k = `${q.roc_year}|${q.session}|${subj}`
    let g = groups.get(k)
    if (!g) {
      g = { year: q.roc_year, session: q.session, subject: subj, exam_code: q.exam_code, nums: new Set() }
      groups.set(k, g)
    }
    g.nums.add(q.number)
    if (!g.exam_code) g.exam_code = q.exam_code
  }

  for (const g of groups.values()) {
    if (!g.nums.size) continue
    const max = Math.max(...g.nums)
    const missing = []
    for (let i = 1; i <= max; i++) if (!g.nums.has(i)) missing.push(i)
    if (missing.length) {
      allGaps.push({ exam, ...g, max, missing, count: g.nums.size })
    }
  }
}

if (!allGaps.length) {
  console.log('✓ No gaps found' + (onlyExam ? ` in ${onlyExam}` : ' across all exams'))
  process.exit(0)
}

// sort by exam, year, session, subject
allGaps.sort((a, b) =>
  a.exam.localeCompare(b.exam) ||
  a.year.localeCompare(b.year) ||
  a.session.localeCompare(b.session) ||
  a.subject.localeCompare(b.subject)
)

let totalMissing = 0
let lastExam = null
for (const g of allGaps) {
  if (g.exam !== lastExam) {
    console.log(`\n=== ${g.exam} ===`)
    lastExam = g.exam
  }
  const missingStr = g.missing.length <= 12
    ? `[${g.missing.join(', ')}]`
    : `[${g.missing.slice(0, 10).join(', ')}, ...+${g.missing.length - 10}]`
  console.log(
    `  ${g.year} ${g.session.padEnd(4)} ${g.subject.padEnd(24)} ` +
    `${String(g.count).padStart(3)}/${String(g.max).padStart(3)}  missing ${missingStr}` +
    (g.exam_code ? `  [code=${g.exam_code}]` : '')
  )
  totalMissing += g.missing.length
}

console.log(`\nTOTAL: ${totalMissing} missing question${totalMissing === 1 ? '' : 's'} across ${allGaps.length} subject-session${allGaps.length === 1 ? '' : 's'}`)
console.log(`PDF URL pattern: ${PDF_BASE}?t=Q&code={exam_code}&c={class}&s={subject}&q=1`)
console.log(`(class/subject codes vary by exam — check scrape-moex.js or scrape-gaps-2026-04.js BATCHES for mapping)`)
