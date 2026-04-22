#!/usr/bin/env node
// Re-tag pharma2 sub-subjects by paper + question number range.
// paper1 (調劑與臨床) 80 題 = 調劑27 + 臨床27 + 治療26 (110+ 起明確分區, 100-109 概略適用)
// paper2 (藥物治療) single tag; paper3 (法規) single tag.

const fs = require('fs')
const path = require('path')
const QFILE = path.join(__dirname, '..', 'questions-pharma2.json')

const MAP = {
  '調劑與臨床': [
    { from: 1,  to: 27, tag: 'dispensing',        name: '調劑學',     stage_id: 1 },
    { from: 28, to: 54, tag: 'clinical_pharmacy', name: '臨床藥學',   stage_id: 2 },
    { from: 55, to: 80, tag: 'therapeutics',      name: '治療學',     stage_id: 3 },
  ],
  '藥物治療': [
    { from: 1, to: 80, tag: 'pharmacotherapy', name: '藥物治療學', stage_id: 4 },
  ],
  '法規': [
    { from: 1, to: 80, tag: 'pharmacy_law', name: '藥事行政與法規', stage_id: 5 },
  ],
}

function classify(q) {
  const rules = MAP[q.subject]
  if (!rules) return null
  const n = q.number
  if (typeof n !== 'number') return null
  for (const r of rules) if (n >= r.from && n <= r.to) return r
  return null
}

function main() {
  const data = JSON.parse(fs.readFileSync(QFILE, 'utf8'))
  const arr = Array.isArray(data) ? data : data.questions
  const stats = {}
  let unmapped = 0
  for (const q of arr) {
    const r = classify(q)
    if (!r) { unmapped++; continue }
    q.subject_tag  = r.tag
    q.subject_name = r.name
    q.stage_id     = r.stage_id
    stats[r.tag] = (stats[r.tag] || 0) + 1
  }
  console.log('sub-subject counts:')
  for (const [t, c] of Object.entries(stats).sort((a,b)=>b[1]-a[1])) console.log(' ', t.padEnd(24), c)
  console.log('unmapped:', unmapped)
  if (process.argv.includes('--dry-run')) { console.log('\n(dry-run, no write)'); return }
  const tmp = QFILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, QFILE)
  console.log('\nwrote', QFILE)
}

main()
