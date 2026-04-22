#!/usr/bin/env node
// Re-tag pharma1 sub-subjects by paper + question number range.
// 卷一 藥理40 + 藥化40 ✓, 卷二 藥分40 + 生藥40 ✓, 卷三 藥劑48 + 生物藥劑32 (實測偏離原 40/40).

const fs = require('fs')
const path = require('path')

const QFILE = path.join(__dirname, '..', 'questions-pharma1.json')

const MAP = {
  '卷一': [
    { from: 1,  to: 40, tag: 'pharmacology',        name: '藥理學',   stage_id: 1 },
    { from: 41, to: 80, tag: 'medicinal_chemistry', name: '藥物化學', stage_id: 2 },
  ],
  '卷二': [
    { from: 1,  to: 40, tag: 'pharmaceutical_analysis', name: '藥物分析', stage_id: 3 },
    { from: 41, to: 80, tag: 'pharmacognosy',           name: '生藥學',   stage_id: 4 },
  ],
  '卷三': [
    { from: 1,  to: 48, tag: 'pharmaceutics',    name: '藥劑學',     stage_id: 5 },
    { from: 49, to: 80, tag: 'biopharmaceutics', name: '生物藥劑學', stage_id: 6 },
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
