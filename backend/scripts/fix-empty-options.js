#!/usr/bin/env node
const fs = require('fs')
const files = ['questions-rt.json', 'questions-tcm1.json', 'questions-vet.json']
let total = 0
for (const f of files) {
  const data = JSON.parse(fs.readFileSync(f, 'utf-8'))
  const arr = data.questions || data
  let n = 0
  for (const q of arr) {
    if (!q.options) continue
    const vals = Object.values(q.options).filter(v => v && String(v).trim())
    if (Object.keys(q.options).length >= 2 && vals.length === 0) {
      if (!q.incomplete) { q.incomplete = 'image_options'; n++ }
    }
  }
  fs.writeFileSync(f, JSON.stringify(data, null, 2))
  console.log(f, ':', n)
  total += n
}
console.log('Total marked:', total)
