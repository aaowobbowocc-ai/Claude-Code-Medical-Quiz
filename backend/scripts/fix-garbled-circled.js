#!/usr/bin/env node
// Fix corrupted circled numbers: U+835B..U+8362 (荛荜荝荞荟荠荡荢) were a font/
// encoding remap of ①②③④⑤⑥⑦⑧ (U+2460..U+2467). Substitute back everywhere.
const fs = require('fs')
const MAP = { '荛': '①', '荜': '②', '荝': '③', '荞': '④', '荟': '⑤', '荠': '⑥', '荡': '⑦', '荢': '⑧' }
const RE = /[荛荜荝荞荟荠荡荢]/g
const fix = s => typeof s === 'string' ? s.replace(RE, m => MAP[m]) : s

const files = fs.readdirSync('.').filter(f => /^questions(-[\w-]+)?\.json$/.test(f))
const sd = 'shared-banks'
const all = files.concat(fs.readdirSync(sd).filter(f => f.endsWith('.json') && !f.startsWith('_')).map(f => sd + '/' + f))
let total = 0
for (const f of all) {
  const data = JSON.parse(fs.readFileSync(f, 'utf-8'))
  const arr = data.questions || data
  let n = 0
  for (const q of arr) {
    let touched = false
    if (q.question && RE.test(q.question)) { q.question = fix(q.question); touched = true }
    if (q.options) {
      for (const k of Object.keys(q.options)) {
        if (typeof q.options[k] === 'string' && RE.test(q.options[k])) { q.options[k] = fix(q.options[k]); touched = true }
      }
    }
    if (q.explanation && RE.test(q.explanation)) { q.explanation = fix(q.explanation); touched = true }
    if (touched) n++
  }
  if (n > 0) { fs.writeFileSync(f, JSON.stringify(data, null, 2)); console.log(f, ':', n); total += n }
}
console.log('TOTAL fixed:', total)
