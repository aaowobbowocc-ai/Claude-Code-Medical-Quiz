#!/usr/bin/env node
// Strip PDF page-footer bleed ("代號：xxxx頁次：x－y") that leaked into
// question stems or option text during parsing. Conservative suffix-only:
// only strips when the footer sits at the END of a string; refuses to
// empty a field (preserves original if clean would be ''), so fields
// that are entirely footer garbage stay flagged for manual review.
//
// Dry-run by default. Pass --write to persist.

const fs = require('fs')
const path = require('path')

const FOOTER_SUFFIX = /\s*代號\s*[:：][^\n]*?(?:頁次\s*[:：]\s*\d+\s*[-—−－]\s*\d+)?\s*$/
const FOOTER_PAGE_ONLY = /\s*頁次\s*[:：]\s*\d+\s*[-—−－]\s*\d+\s*$/

function clean(s) {
  if (typeof s !== 'string') return s
  const r = s.replace(FOOTER_SUFFIX, '').replace(FOOTER_PAGE_ONLY, '')
  return r.trim() === '' ? s : r
}

const FILES = [
  'questions.json', 'questions-doctor2.json',
  'questions-dental1.json', 'questions-dental2.json',
  'questions-pharma1.json', 'questions-pharma2.json',
  'questions-nursing.json', 'questions-nutrition.json',
  'questions-pt.json', 'questions-ot.json',
  'questions-medlab.json',
  'questions-tcm1.json', 'questions-tcm2.json',
  'questions-vet.json',
]

const write = process.argv.includes('--write')
const base = path.join(__dirname, '..')
let grandTotal = 0

for (const f of FILES) {
  const p = path.join(base, f)
  if (!fs.existsSync(p)) continue
  const d = JSON.parse(fs.readFileSync(p, 'utf8'))
  const qs = Array.isArray(d) ? d : d.questions
  if (!Array.isArray(qs)) continue
  let fixed = 0
  for (const q of qs) {
    const qNew = clean(q.question)
    if (qNew !== q.question) { q.question = qNew; fixed++ }
    if (q.options) {
      for (const k of ['A', 'B', 'C', 'D']) {
        const vNew = clean(q.options[k])
        if (vNew !== q.options[k]) { q.options[k] = vNew; fixed++ }
      }
    }
  }
  if (fixed > 0) {
    console.log(`${f.padEnd(26)} ${write ? 'fixed' : 'would fix'}: ${fixed}`)
    grandTotal += fixed
    if (write) {
      const tmp = p + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(d, null, 2))
      fs.renameSync(tmp, p)
    }
  }
}
console.log(`TOTAL: ${grandTotal} ${write ? 'fixes applied' : 'fixes pending (pass --write to persist)'}`)
