#!/usr/bin/env node
// Apply manual answer corrections to questions.json (doctor1)
// Format per entry: { year, session, subject, number, kind: 'void'|'multi', answers? }

const fs = require('fs')
const path = require('path')

const CORRECTIONS = [
  { year: '110', session: '第一次', subject: '醫學(二)', number: 64,  kind: 'void' },
  { year: '111', session: '第一次', subject: '醫學(二)', number: 36,  kind: 'multi', answers: 'A,D' },
  { year: '111', session: '第一次', subject: '醫學(二)', number: 59,  kind: 'multi', answers: 'A,B' },
  { year: '112', session: '第一次', subject: '醫學(一)', number: 66,  kind: 'multi', answers: 'B,D' },
  { year: '112', session: '第一次', subject: '醫學(二)', number: 47,  kind: 'void' },
  { year: '113', session: '第一次', subject: '醫學(一)', number: 3,   kind: 'void' },
  { year: '113', session: '第一次', subject: '醫學(一)', number: 43,  kind: 'void' },
  { year: '114', session: '第一次', subject: '醫學(二)', number: 23,  kind: 'void' },
  { year: '114', session: '第一次', subject: '醫學(二)', number: 42,  kind: 'multi', answers: 'A,D' },
  { year: '114', session: '第二次', subject: '醫學(一)', number: 49,  kind: 'multi', answers: 'A,C' },
  { year: '114', session: '第二次', subject: '醫學(一)', number: 94,  kind: 'multi', answers: 'C,D' },
  { year: '114', session: '第二次', subject: '醫學(一)', number: 100, kind: 'void' },
  { year: '115', session: '第一次', subject: '醫學(一)', number: 66,  kind: 'multi', answers: 'A,D' },
  { year: '115', session: '第一次', subject: '醫學(一)', number: 95,  kind: 'void' },
  { year: '115', session: '第一次', subject: '醫學(二)', number: 1,   kind: 'multi', answers: 'A,C' },
  { year: '115', session: '第一次', subject: '醫學(二)', number: 8,   kind: 'multi', answers: 'C,D' },
]

const FILE = path.join(__dirname, '..', 'questions.json')
const data = JSON.parse(fs.readFileSync(FILE, 'utf8'))
const qs = data.questions || data

let applied = 0
let skipped = 0
for (const c of CORRECTIONS) {
  const q = qs.find(q =>
    q.roc_year === c.year &&
    q.session === c.session &&
    q.subject === c.subject &&
    q.number === c.number
  )
  if (!q) {
    console.log(`  ❌ SKIP ${c.year}${c.session} ${c.subject} #${c.number} — not found`)
    skipped++
    continue
  }
  const origAns = q.answer
  if (c.kind === 'void') {
    q.answer = '送分'
    q.disputed = true
    q.original_answer = origAns
    q.correction_note = `第${c.number}題一律給分（原答案 ${origAns}）`
    console.log(`  ✓ VOID ${c.year}${c.session} ${c.subject} #${c.number} (was ${origAns})`)
  } else {
    q.answer = c.answers
    q.disputed = true
    q.original_answer = origAns
    q.correction_note = `第${c.number}題更正為 ${c.answers}（原答案 ${origAns}）`
    console.log(`  ✓ MULTI ${c.year}${c.session} ${c.subject} #${c.number} ${origAns} → ${c.answers}`)
  }
  applied++
}

console.log(`\nApplied: ${applied} | Skipped: ${skipped} / ${CORRECTIONS.length}`)

if (applied > 0) {
  if (data.questions) data.questions = qs
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n')
  console.log(`Wrote ${FILE}`)
}
