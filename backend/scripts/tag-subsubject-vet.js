#!/usr/bin/env node
// vet 每卷 80 題 = 1 個單一學科，直接把 subject (paper) 映成 subject_tag + stage_id.

const fs = require('fs')
const path = require('path')
const QFILE = path.join(__dirname, '..', 'questions-vet.json')

const MAP = {
  '獸醫病理學':       { tag: 'vet_pathology',    name: '獸醫病理學',   stage_id: 1 },
  '獸醫藥理學':       { tag: 'vet_pharmacology', name: '獸醫藥理學',   stage_id: 2 },
  '獸醫實驗診斷學':   { tag: 'vet_lab_diagnosis',  name: '獸醫實驗診斷學', stage_id: 3 },
  '獸醫普通疾病學':   { tag: 'vet_common_disease', name: '獸醫普通疾病學', stage_id: 4 },
  '獸醫傳染病學':     { tag: 'vet_infectious',   name: '獸醫傳染病學',   stage_id: 5 },
  '獸醫公共衛生學':   { tag: 'vet_public_health', name: '獸醫公共衛生學', stage_id: 6 },
}

function main() {
  const data = JSON.parse(fs.readFileSync(QFILE, 'utf8'))
  const arr = Array.isArray(data) ? data : data.questions
  const stats = {}
  let unmapped = 0
  for (const q of arr) {
    const m = MAP[q.subject]
    if (!m) { unmapped++; continue }
    q.subject_tag  = m.tag
    q.subject_name = m.name
    q.stage_id     = m.stage_id
    stats[m.tag] = (stats[m.tag] || 0) + 1
  }
  console.log('vet sub-subject counts:')
  for (const [t, c] of Object.entries(stats).sort((a,b)=>b[1]-a[1])) console.log(' ', t.padEnd(24), c)
  console.log('unmapped:', unmapped)
  if (process.argv.includes('--dry-run')) { console.log('\n(dry-run, no write)'); return }
  const tmp = QFILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, QFILE)
  console.log('\nwrote', QFILE)
}

main()
