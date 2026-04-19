// Scan all question banks for the eaten-AC-options bug pattern.
const fs = require('fs')
const path = require('path')
const dir = path.join(__dirname, '..')
const files = fs.readdirSync(dir).filter(f => f.startsWith('questions-') && f.endsWith('.json'))
const RX_MARK = /[①②③④⑤⑥⑦⑧]/
const groups = {}
const all = []
for (const f of files) {
  let d
  try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch (e) { continue }
  const qs = Array.isArray(d) ? d : d.questions
  if (!qs) continue
  for (const q of qs) {
    if (q.incomplete) continue
    if (!q.question || !q.options) continue
    if (!RX_MARK.test(q.question)) continue
    const opts = q.options
    const empA = !opts.A || !opts.A.trim()
    const empC = !opts.C || !opts.C.trim()
    const fullB = RX_MARK.test(opts.B || '')
    const fullD = RX_MARK.test(opts.D || '')
    if (empA && empC && fullB && fullD) {
      const k = `${f}|${q.exam_code}|${q.subject}`
      groups[k] = (groups[k] || 0) + 1
      all.push({ file: f, id: q.id, year: q.roc_year, exam_code: q.exam_code, subject: q.subject, number: q.number })
    }
  }
}
const sorted = Object.entries(groups).sort((a, b) => b[1] - a[1])
console.log('Total bad questions:', all.length, '| groups:', sorted.length)
for (const [k, n] of sorted) console.log(n, k)
