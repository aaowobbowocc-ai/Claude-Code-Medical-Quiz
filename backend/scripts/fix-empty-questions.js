#!/usr/bin/env node
// Mark questions with empty/short question text as incomplete (excluded from quiz pool)
// EXCEPT driver-car/driver-moto road sign true-false questions (legitimate short stems)
const fs = require('fs')
const TARGETS = ['questions-customs.json','questions-police4.json','questions-medlab.json','questions-ot.json','questions-audiologist.json','questions-speech-therapist.json']
let total = 0
for (const f of TARGETS) {
  if (!fs.existsSync(f)) continue
  const data = JSON.parse(fs.readFileSync(f, 'utf-8'))
  const arr = data.questions || data
  let n = 0
  for (const q of arr) {
    if (q.question && q.question.length < 5 && q.type !== 'tf') {
      if (!q.incomplete) { q.incomplete = 'empty_question'; n++ }
    }
  }
  if (n > 0) {
    fs.writeFileSync(f, JSON.stringify(data, null, 2))
    console.log(f, ':', n)
    total += n
  }
}
console.log('Total:', total)
