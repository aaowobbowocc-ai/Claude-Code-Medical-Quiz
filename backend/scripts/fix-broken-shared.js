#!/usr/bin/env node
// Mark shared-bank entries with answer-no-option mismatch as incomplete
const fs = require('fs')
const files = [
  'shared-banks/common_admin_law.json',
  'shared-banks/common_admin_law_junior.json',
  'shared-banks/common_admin_studies.json',
  'shared-banks/common_admin_studies_junior.json',
  'shared-banks/common_chinese.json',
  'shared-banks/common_constitution.json',
  'shared-banks/common_english.json',
]
let total = 0
for (const fp of files) {
  if (!fs.existsSync(fp)) continue
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data
  let n = 0
  for (const q of arr) {
    if (!q.options) continue
    if (!/^[A-D]$/.test(q.answer)) continue
    if (q.options[q.answer]) continue
    if (q.incomplete) continue
    q.incomplete = 'truncated_options'
    n++
  }
  // Also mark very-short questions in shared-banks (≤4 chars) as incomplete
  for (const q of arr) {
    if (q.question && q.question.length < 5 && !q.incomplete) {
      q.incomplete = 'short_question'
      n++
    }
  }
  if (n > 0) {
    fs.writeFileSync(fp, JSON.stringify(data, null, 2))
    console.log(fp, ':', n)
    total += n
  }
}
console.log('Total marked:', total)
