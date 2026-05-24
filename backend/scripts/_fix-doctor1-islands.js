// One-off: fix 10 confirmed subject_tag islands in doctor1 (questions.json).
// Each island is a 1-2 question run sandwiched between ≥4-question blocks of a
// different subject — verified by content + neighbour context.
const fs = require('fs'), path = require('path')
const FILE = path.resolve(__dirname, '..', 'questions.json')

// config doctor1 stages: tag → stage_id
const STAGE = { anatomy: 1, physiology: 2, biochemistry: 3, histology: 4, embryology: 10,
  microbiology: 5, parasitology: 6, pharmacology: 7, pathology: 8, public_health: 9 }

// [roc_year, session, subject, [numbers], correctTag]
const FIXES = [
  ['110', '第一次', '醫學(一)', [41, 42], 'histology'],
  ['111', '第一次', '醫學(一)', [15, 16], 'anatomy'],
  ['111', '第一次', '醫學(一)', [25, 26], 'anatomy'],
  ['111', '第一次', '醫學(二)', [10, 11], 'microbiology'],
  ['114', '第一次', '醫學(二)', [88, 89], 'pathology'],
  ['114', '第二次', '醫學(二)', [12, 13], 'microbiology'],
  ['106', '第二次', '醫學(一)', [61], 'physiology'],
  ['106', '第二次', '醫學(一)', [70], 'physiology'],
  ['102', '第一次', '醫學(二)', [7, 8], 'microbiology'],
  ['107', '第一次', '醫學(二)', [45, 46], 'public_health'],
]

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'))
const arr = data.questions
let fixed = 0
for (const [y, s, subj, nums, tag] of FIXES) {
  for (const n of nums) {
    const q = arr.find(x => x.roc_year === y && x.session === s && x.subject === subj && x.number === n)
    if (!q) { console.log(`✗ 找不到 ${y}${s} ${subj} #${n}`); continue }
    const old = q.subject_tag
    q.subject_tag = tag
    q.stage_id = STAGE[tag]
    console.log(`✓ ${y}${s} ${subj} #${n}: ${old} → ${tag} (stage_id=${STAGE[tag]})`)
    fixed++
  }
}
fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n')
console.log(`\n已修正 ${fixed} 題，寫回 questions.json`)
