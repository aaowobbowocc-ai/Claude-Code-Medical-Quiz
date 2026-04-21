#!/usr/bin/env node
// Final stray: nutrition 113100 公共衛生營養學 #50 (answer D from official S PDF).
const fs = require('fs')
const path = require('path')

const FILE = path.join(__dirname, '..', 'questions-nutrition.json')
const db = JSON.parse(fs.readFileSync(FILE, 'utf8'))

const NEW = {
  id: '113100_0105_50', roc_year: '113', session: '第二次', exam_code: '113100',
  subject: '公共衛生營養學', subject_tag: 'public_nutrition', subject_name: '公共衛生營養學',
  stage_id: 0, number: 50,
  question: '營養教育的方式，下列敘述何者錯誤？',
  options: {
    A: '示範法適合學習技能',
    B: '大眾傳播法能觸及較多民眾',
    C: '課堂教學法可提供較完整之營養知識',
    D: '一對一接觸教學容易控制進度且花費低',
  },
  answer: 'D', explanation: '',
}

if (db.questions.some(q => q.id === NEW.id)) {
  console.error('DUPLICATE:', NEW.id); process.exit(1)
}

let insertAt = -1
for (let i = 0; i < db.questions.length; i++) {
  const q = db.questions[i]
  if (q.exam_code === NEW.exam_code && q.subject === NEW.subject && q.number < NEW.number) insertAt = i + 1
}
if (insertAt < 0) insertAt = db.questions.length
db.questions.splice(insertAt, 0, NEW)

db.total = db.questions.length
if (db.metadata) {
  db.metadata.total = db.questions.length
  db.metadata.last_updated = new Date().toISOString()
}
fs.writeFileSync(FILE, JSON.stringify(db, null, 2))
console.log(`Inserted 1. New total: ${db.total}`)
