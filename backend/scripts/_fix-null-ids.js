// One-off: backfill missing (null) question ids.
// nutrition 112-2 (240) + radiology 111-2 放射器材學 (11) were scraped without ids,
// causing id collisions (server appends _paperId → all become "null_<paper>"),
// breaking bookmarks / AI-explain cache / 題目回報 question_id.
const fs = require('fs'), path = require('path')
const BK = path.resolve(__dirname, '..')

function fixFile(file, assignId) {
  const fp = path.join(BK, file)
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
  const arr = data.questions || data
  const existing = new Set(arr.filter(q => q.id != null && q.id !== '').map(q => String(q.id)))
  let fixed = 0, collision = 0
  for (const q of arr) {
    if (q.id != null && q.id !== '') continue
    const newId = assignId(q, existing)
    if (existing.has(String(newId))) { collision++; console.log(`  ✗ 撞號 ${newId}`); continue }
    q.id = newId
    existing.add(String(newId))
    fixed++
  }
  fs.writeFileSync(fp, JSON.stringify(data, null, 2) + '\n')
  console.log(`${file}: 補 ${fixed} 個 id${collision ? `，${collision} 個撞號未處理` : ''}`)
  return { fixed, collision }
}

// nutrition — string id scheme: {exam_code}_{subject_tag}_{number}
fixFile('questions-nutrition.json', q => `${q.exam_code}_${q.subject_tag}_${q.number}`)

// radiology — numeric id scheme: max existing numeric id + running counter
const radPath = path.join(BK, 'questions-radiology.json')
const radData = JSON.parse(fs.readFileSync(radPath, 'utf8'))
const radArr = radData.questions || radData
const maxNum = Math.max(...radArr.map(q => Number(q.id)).filter(n => Number.isFinite(n)))
let radCounter = maxNum
fixFile('questions-radiology.json', () => ++radCounter)

// verify
for (const file of ['questions-nutrition.json', 'questions-radiology.json']) {
  const arr = JSON.parse(fs.readFileSync(path.join(BK, file), 'utf8')).questions || []
  const nulls = arr.filter(q => q.id == null || q.id === '').length
  const ids = arr.map(q => String(q.id))
  const dups = ids.length - new Set(ids).size
  console.log(`✓ ${file}: 剩 ${nulls} 個 null id，重複 id ${dups} 個`)
}
