// Mark questions with eaten A/C options (column parser bug) as incomplete.
// Also handles the singleton 9184 (all-僅 pattern).
const fs = require('fs')
const path = require('path')

const dir = path.join(__dirname, '..')
const RX_MARK = /[①②③④⑤⑥⑦⑧]/

function isEatenAC(q) {
  if (!q.question || !q.options) return false
  if (!RX_MARK.test(q.question)) return false
  const o = q.options
  return !(o.A || '').trim() && !(o.C || '').trim()
    && RX_MARK.test(o.B || '') && RX_MARK.test(o.D || '')
}

function isAllJin(q) {
  if (!q.options) return false
  const opts = Object.values(q.options)
  return opts.length === 4 && opts.filter(o => (o || '').trim() === '僅').length === 4
}

const files = fs.readdirSync(dir).filter(f => f.startsWith('questions-') && f.endsWith('.json'))
let touched = 0
const log = []
for (const f of files) {
  const fp = path.join(dir, f)
  let d
  try { d = JSON.parse(fs.readFileSync(fp, 'utf8')) } catch (e) { continue }
  const qs = Array.isArray(d) ? d : d.questions
  if (!qs) continue
  let fileChanged = 0
  for (const q of qs) {
    if (q.incomplete) continue
    if (isEatenAC(q) || isAllJin(q)) {
      q.incomplete = true
      fileChanged++
      log.push(`${f} id=${q.id} ${q.roc_year}年 ${q.subject} #${q.number}`)
    }
  }
  if (fileChanged) {
    fs.writeFileSync(fp, JSON.stringify(d, null, 2))
    touched += fileChanged
    console.log(`  ${f}: marked ${fileChanged}`)
  }
}
console.log(`\nTotal marked incomplete: ${touched}`)
for (const l of log) console.log(l)
