#!/usr/bin/env node
// Apply 4 verified stem corrections from the truncated-stem audit.
// vet 63 (110100 #63 「禽痘包含體為：」) is not truncated — original PDF
// stem is identical, so it's omitted.
const fs = require('fs')
const path = require('path')

const FIXES = [
  {
    file: 'questions-medlab.json',
    id: 3989,
    newStem: '有關Mia抗原的敘述，下列何者正確？',
  },
  {
    file: 'questions-nutrition.json',
    id: '113100_public_nutrition_32',
    newStem: '營養諮詢領域中常見的動機訪談法（motivational interviewing）中，4個基本技巧以OARS來表示，其中O代表：',
  },
  {
    file: 'questions-nutrition.json',
    id: '113100_public_nutrition_46',
    newStem: '營養師於社區執行免費健康飲食衛生講座活動，以提升長者的健康飲食習慣。此活動屬於推動公共衛生的何種手段？',
  },
  {
    file: 'questions-ot.json',
    id: 252,
    newStem: '艾倫（Allen）認知功能階層關於姿勢動作（postural actions）層級的敘述，下列何者錯誤？',
  },
]

let totalFixed = 0
const byFile = {}
for (const f of FIXES) {
  if (!byFile[f.file]) byFile[f.file] = []
  byFile[f.file].push(f)
}

for (const [file, fixes] of Object.entries(byFile)) {
  const fp = path.join(__dirname, '..', file)
  const db = JSON.parse(fs.readFileSync(fp, 'utf8'))
  const qs = db.questions || db
  let fixed = 0
  for (const fix of fixes) {
    const q = qs.find(x => x.id === fix.id)
    if (!q) { console.error(`  ❌ ${file} id=${fix.id} not found`); continue }
    const before = q.question
    q.question = fix.newStem
    fixed++
    console.log(`  ✓ ${file} id=${fix.id}`)
    console.log(`      before: ${JSON.stringify(before)}`)
    console.log(`      after : ${JSON.stringify(fix.newStem.slice(0, 60))}…`)
  }
  if (fixed && db.metadata) db.metadata.last_updated = new Date().toISOString()
  fs.writeFileSync(fp, JSON.stringify(db, null, 2))
  totalFixed += fixed
}
console.log(`\nTotal stems fixed: ${totalFixed}`)
