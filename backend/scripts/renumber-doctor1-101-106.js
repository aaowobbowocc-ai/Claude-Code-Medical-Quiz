#!/usr/bin/env node
// After paper reassignment, doctor1 101-106 papers have duplicate question
// numbers (same N appears multiple times within one paper). Renumber
// sequentially within each (year, session, subject) group.
// Preserves original number in `_original_number` for traceability.
const fs = require('fs')
const data = JSON.parse(fs.readFileSync('questions.json', 'utf-8'))
const arr = data.questions || data

// Group by (year, session, subject)
const groups = {}
for (const q of arr) {
  if (q.roc_year === '100') continue
  if (parseInt(q.roc_year) >= 107) continue
  if (q.subject !== '醫學(一)' && q.subject !== '醫學(二)') continue
  const k = `${q.roc_year}|${q.session}|${q.subject}`
  if (!groups[k]) groups[k] = []
  groups[k].push(q)
}

let renumbered = 0
for (const [k, qs] of Object.entries(groups)) {
  // Sort by current number to maintain visual order (anatomy → embryology → ...
  // within MED1, etc., per PDF original layout).
  qs.sort((a, b) => (a.number || 0) - (b.number || 0))
  // Renumber sequentially
  let n = 1
  for (const q of qs) {
    if (q.number !== n) {
      q._original_number = q.number
      q.number = n
      renumbered++
    }
    n++
  }
}
fs.writeFileSync('questions.json', JSON.stringify(data, null, 2))
console.log('Renumbered:', renumbered)
