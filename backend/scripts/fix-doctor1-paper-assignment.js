#!/usr/bin/env node
// Fix doctor1 101-106 paper assignment: 醫學(一)/醫學(二) 混亂
// Strategy: trust subject_tag, reassign subject by tag → paper mapping
// MED1 tags → 醫學(一), MED2 tags → 醫學(二)
// Skip year 100 (different split) + 107+ (already correct)
const fs = require('fs')

const MED1 = new Set(['anatomy', 'embryology', 'histology', 'physiology', 'biochemistry'])
const MED2 = new Set(['microbiology', 'parasitology', 'public_health', 'pharmacology', 'pathology'])

const data = JSON.parse(fs.readFileSync('questions.json', 'utf-8'))
const arr = data.questions || data

let movedToMed1 = 0, movedToMed2 = 0, skipped = 0
for (const q of arr) {
  if (q.roc_year === '100') continue // pre-101 different split
  if (parseInt(q.roc_year) >= 107) continue // 107+ already clean
  if (q.subject !== '醫學(一)' && q.subject !== '醫學(二)') continue
  if (!q.subject_tag) continue
  if (MED1.has(q.subject_tag) && q.subject === '醫學(二)') {
    q.subject = '醫學(一)'
    movedToMed1++
  } else if (MED2.has(q.subject_tag) && q.subject === '醫學(一)') {
    q.subject = '醫學(二)'
    movedToMed2++
  } else {
    skipped++
  }
}

fs.writeFileSync('questions.json', JSON.stringify(data, null, 2))
console.log('moved to 醫學(一):', movedToMed1)
console.log('moved to 醫學(二):', movedToMed2)
console.log('untouched (already correct):', skipped)
console.log('Total moved:', movedToMed1 + movedToMed2)
