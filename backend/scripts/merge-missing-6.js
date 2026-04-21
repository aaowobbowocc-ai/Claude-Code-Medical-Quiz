#!/usr/bin/env node
// Insert 6 hand-transcribed missing questions (4 nursing + 2 nutrition) into
// questions-nursing.json / questions-nutrition.json. Answers verified via
// bbox column matching against official S PDFs.
const fs = require('fs')
const path = require('path')

const NURSING_FILE = path.join(__dirname, '..', 'questions-nursing.json')
const NUTRITION_FILE = path.join(__dirname, '..', 'questions-nutrition.json')

const NURSING_NEW = [
  {
    id: '112030_0201_23', roc_year: '112', session: '第一次', exam_code: '112030',
    subject: '基礎醫學', subject_tag: 'basic_medicine', subject_name: '基礎醫學',
    stage_id: 0, number: 23,
    question: '下列何者是兒童接受肝臟移植最常見的原因？',
    options: {
      A: '肝母細胞癌（hepatoblastoma）',
      B: '肝細胞癌（hepatocellular carcinoma）',
      C: '原發性膽道性硬化（primary biliary cirrhosis）',
      D: '膽道閉鎖（biliary atresia）',
    },
    answer: 'D', explanation: '',
  },
  {
    id: '112030_0202_65', roc_year: '112', session: '第一次', exam_code: '112030',
    subject: '基本護理學與護理行政', subject_tag: 'basic_nursing', subject_name: '基本護理學與護理行政',
    stage_id: 0, number: 65,
    question: '「激勵產生於員工感受到自己的報酬（如薪資、獎賞）與同儕一樣」，屬於下列何種激勵理論的主張？',
    options: {
      A: 'ERG 理論',
      B: '期望理論',
      C: '公平理論',
      D: '增強理論',
    },
    answer: 'C', explanation: '',
  },
  {
    id: '112030_0203_9', roc_year: '112', session: '第一次', exam_code: '112030',
    subject: '內外科護理學', subject_tag: 'med_surg', subject_name: '內外科護理學',
    stage_id: 0, number: 9,
    question: 'B 型肝炎病毒帶原者且 HBeAg（+），下列敘述何者正確？',
    options: {
      A: '目前是急性 B 型肝炎病毒的恢復期',
      B: '對於 B 型肝炎病毒已經有免疫力',
      C: '目前具有 B 型肝炎病毒高傳染力',
      D: '可能會併發 C 型肝炎病毒感染',
    },
    answer: 'C', explanation: '',
  },
  {
    id: '113100_0202_43', roc_year: '113', session: '第二次', exam_code: '113100',
    subject: '基本護理學與護理行政', subject_tag: 'basic_nursing', subject_name: '基本護理學與護理行政',
    stage_id: 0, number: 43,
    question: 'A 病房 50 床，平均直接護理時數 2.0，平均間接護理時數 0.5，平均相關護理時數 0.5，休假係數為 1.6，請問 A 病房所需的護理人力為多少？',
    options: {
      A: '27 人',
      B: '28 人',
      C: '29 人',
      D: '30 人',
    },
    answer: 'D', explanation: '',
  },
]

const NUTRITION_NEW = [
  {
    id: '113100_0104_42', roc_year: '113', session: '第二次', exam_code: '113100',
    subject: '營養學', subject_tag: 'nutrition_science', subject_name: '營養學',
    stage_id: 0, number: 42,
    question: 'Cobalt 與下列何種營養素有關？',
    options: {
      A: 'vitamin B12',
      B: 'vitamin B2',
      C: 'vitamin B1',
      D: 'vitamin B6',
    },
    answer: 'A', explanation: '',
  },
  {
    id: '113100_0105_31', roc_year: '113', session: '第二次', exam_code: '113100',
    subject: '公共衛生營養學', subject_tag: 'public_nutrition', subject_name: '公共衛生營養學',
    stage_id: 0, number: 31,
    question: '營養教育中常講述飲食與慢性疾病風險的學術報告，此為藉由下列何種中介因子的教學策略？',
    options: {
      A: '自覺危機',
      B: '意識覺醒',
      C: '結果期待',
      D: '知覺障礙',
    },
    answer: 'C', explanation: '',
  },
]

function mergeInto(file, newQs) {
  const db = JSON.parse(fs.readFileSync(file, 'utf8'))
  const existing = new Set(db.questions.map(q => q.id))
  const dupes = newQs.filter(q => existing.has(q.id))
  if (dupes.length) {
    console.error('DUPLICATE IDs in', path.basename(file), ':', dupes.map(q => q.id))
    process.exit(1)
  }

  for (const nq of newQs) {
    let insertAt = -1
    for (let i = 0; i < db.questions.length; i++) {
      const q = db.questions[i]
      if (q.exam_code === nq.exam_code && q.subject === nq.subject && q.number < nq.number) {
        insertAt = i + 1
      }
    }
    if (insertAt < 0) {
      for (let i = 0; i < db.questions.length; i++) {
        const q = db.questions[i]
        if (q.exam_code === nq.exam_code && q.subject === nq.subject) insertAt = i + 1
      }
    }
    if (insertAt < 0) insertAt = db.questions.length
    db.questions.splice(insertAt, 0, nq)
  }

  db.total = db.questions.length
  if (db.metadata) {
    db.metadata.total = db.questions.length
    db.metadata.last_updated = new Date().toISOString()
  }
  fs.writeFileSync(file, JSON.stringify(db, null, 2))
  console.log(`${path.basename(file)}: inserted ${newQs.length}, new total ${db.total}`)
}

mergeInto(NURSING_FILE, NURSING_NEW)
mergeInto(NUTRITION_FILE, NUTRITION_NEW)
