#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const BACKEND = path.join(__dirname, '..')

const ENTRIES = [
  {
    file: 'questions-audiologist.json',
    year: '110', sess: '第一次', code: '110111',
    subject: '基礎聽力科學', tag: 'audio_basic',
    number: 5,
    question: '100 分貝的聲音強度(intensity level)是50 分貝聲音強度的幾倍？',
    options: { A: '2', B: '50', C: '1,000', D: '100,000' },
    answer: 'D',
  },
  {
    file: 'questions-audiologist.json',
    year: '111', sess: '第一次', code: '111110',
    subject: '聽覺輔具原理與實務學', tag: 'audio_devices',
    number: 7,
    question: '一個全新675 號鋅空電池的電池容量為600 mAh，若個案一天使用助聽器8 小時，助聽器耗電量為2 mA，可使用時間約為多少週？',
    options: { A: '1', B: '3', C: '5', D: '7' },
    answer: 'C',
  },
]

let total = 0
for (const e of ENTRIES) {
  const fp = path.join(BACKEND, e.file)
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data
  if (arr.find(q => q.exam_code === e.code && q.subject === e.subject && q.number === e.number)) {
    console.log(`skip ${e.code}|${e.subject}|#${e.number}`); continue
  }
  const maxId = arr.reduce((m, q) => Math.max(m, parseInt(String(q.id).replace(/\D/g, '')) || 0), 0)
  arr.push({
    id: maxId + 1,
    roc_year: e.year, session: e.sess, exam_code: e.code,
    subject: e.subject, subject_tag: e.tag, subject_name: e.subject,
    stage_id: 0, number: e.number,
    question: e.question, options: e.options, answer: e.answer,
    explanation: '',
  })
  arr.sort((a, b) => {
    if (a.exam_code !== b.exam_code) return String(a.exam_code).localeCompare(String(b.exam_code))
    if (a.subject !== b.subject) return String(a.subject).localeCompare(String(b.subject))
    return (a.number || 0) - (b.number || 0)
  })
  fs.writeFileSync(fp, JSON.stringify(data, null, 2))
  console.log(`+ ${e.year}-${e.sess} ${e.subject} #${e.number}`)
  total++
}
console.log(`\nTOTAL +${total}`)
