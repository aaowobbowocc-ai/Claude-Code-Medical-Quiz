#!/usr/bin/env node
// Re-tag medlab questions with sub-subject granularity (per paper number range).
// 5/6 papers split cleanly at Q1-40 / Q41-80; paper4 (microbiology) stays single.
// Verified boundary stability across 100-114 年度 sampled via scripts/probe-medlab-boundaries (inline check).

const fs = require('fs')
const path = require('path')

const QFILE = path.join(__dirname, '..', 'questions-medlab.json')

// Per-paper-subject sub-subject mapping. stage_id is fresh per exam (medlab).
const MAP = {
  '臨床生理學與病理學': [
    { from: 1,  to: 40, tag: 'clinical_physiology', name: '臨床生理學', stage_id: 1 },
    { from: 41, to: 80, tag: 'pathology',           name: '病理學',      stage_id: 2 },
  ],
  '臨床血液學與血庫學': [
    { from: 1,  to: 40, tag: 'hematology',  name: '臨床血液學', stage_id: 3 },
    { from: 41, to: 80, tag: 'blood_bank',  name: '血庫學',     stage_id: 4 },
  ],
  '醫學分子檢驗學與臨床鏡檢學': [
    { from: 1,  to: 40, tag: 'clinical_micro', name: '臨床鏡檢學',     stage_id: 5 },
    { from: 41, to: 80, tag: 'molecular_dx',   name: '醫學分子檢驗學', stage_id: 6 },
  ],
  '微生物學與臨床微生物學': [
    { from: 1,  to: 80, tag: 'medical_microbiology', name: '微生物學', stage_id: 7 },
  ],
  '生物化學與臨床生化學': [
    { from: 1,  to: 40, tag: 'biochemistry',     name: '生物化學',   stage_id: 8 },
    { from: 41, to: 80, tag: 'clinical_biochem', name: '臨床生化學', stage_id: 9 },
  ],
  '臨床血清免疫學與臨床病毒學': [
    { from: 1,  to: 40, tag: 'serology', name: '臨床血清免疫學', stage_id: 10 },
    { from: 41, to: 80, tag: 'virology', name: '臨床病毒學',     stage_id: 11 },
  ],
}

function classify(q) {
  const rules = MAP[q.subject]
  if (!rules) return null
  const n = q.number
  if (typeof n !== 'number') return null
  for (const r of rules) {
    if (n >= r.from && n <= r.to) return r
  }
  return null
}

function main() {
  const raw = fs.readFileSync(QFILE, 'utf8')
  const data = JSON.parse(raw)
  const arr = Array.isArray(data) ? data : data.questions
  if (!Array.isArray(arr)) throw new Error('unexpected file shape')

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

  if (process.argv.includes('--dry-run')) {
    console.log('\n(dry-run, no write)')
    return
  }

  const tmp = QFILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, QFILE)
  console.log('\nwrote', QFILE)
}

main()
