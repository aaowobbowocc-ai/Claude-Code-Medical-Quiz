#!/usr/bin/env node
/**
 * Manual fill — 5 nursing questions whose options have inline/multiline
 * formats that defeat all auto-parsers. Hand-extracted from cached PDFs.
 */
const fs = require('fs')
const path = require('path')

const BACKEND = path.join(__dirname, '..')

const ENTRIES = [
  {
    file: 'questions-nursing.json',
    year: '102', sess: '第一次', code: '102030',
    subject: '精神科與社區衛生護理學', tag: 'psychiatric_nursing',
    number: 47,
    question: '公衛護理師協同環保人員採集社區中工廠的排放水，以檢驗水質淨化程度，屬於三段五級的那一段預防？',
    options: {
      A: '初段預防的健康促進',
      B: '初段預防的特殊保護',
      C: '二段預防的早期發現',
      D: '三段預防的限制殘障',
    },
    answer: 'B',
  },
  {
    file: 'questions-nursing.json',
    year: '102', sess: '第一次', code: '102030',
    subject: '精神科與社區衛生護理學', tag: 'psychiatric_nursing',
    number: 72,
    question: '某學校要求學生每天跑步15 分鐘，以維持適當體位，從預防疾病的概念而言，此措施屬於：',
    options: {
      A: '第一段第一級的預防',
      B: '第一段第二級的預防',
      C: '第二段第三級的預防',
      D: '第三段第四級的預防',
    },
    answer: 'A',
  },
  {
    file: 'questions-nursing.json',
    year: '101', sess: '第二次', code: '101110',
    subject: '基本護理學與護理行政', tag: 'fundamental_nursing',
    number: 41,
    question: '11 歲的張小妹詢問護理師，為何她的血壓較爸爸的血壓低，下列回答何者適宜？',
    options: {
      A: '因為妳沒有高血壓，血壓當然比較低',
      B: '因為爸爸年紀大、血管彈性減少，因此血壓上升',
      C: '因為爸爸年紀大，所以血壓高',
      D: '一般而言，女生的血壓較男生低，所以爸爸的血壓比較高',
    },
    answer: 'B',
  },
  {
    file: 'questions-nursing.json',
    year: '101', sess: '第二次', code: '101110',
    subject: '產兒科護理學', tag: 'obstetric_nursing',
    number: 72,
    question: '下列婦女孕期感染病毒的處置陳述，何者正確？',
    options: {
      A: '孕婦若為B 型肝炎帶原者，會經由產道感染給胎兒，宜在新生兒出生後72 小時內注射B 型肝炎疫苗',
      B: '孕婦若感染疱疹病毒(HSV-II)，應採剖腹生產方式生產，以避免傳染給胎兒',
      C: '孕婦若感染巨細胞病毒，可經由胎盤、產道傳染給胎兒，但不會經由乳汁傳染給新生兒',
      D: '若欲知胎兒是否也感染德國麻疹病毒，可檢測胎兒臍帶血中之IgG 是否過高',
    },
    answer: 'B',
  },
  {
    file: 'questions-nursing.json',
    year: '101', sess: '第二次', code: '101110',
    subject: '精神科與社區衛生護理學', tag: 'psychiatric_nursing',
    number: 28,
    question: '薛太太，診斷為精神分裂症，入院3 天，常站在窗邊自言自語且自笑，請問下列護理措施何者正確？',
    options: {
      A: '當薛太太出現幻覺症狀時，護理師應安排薛太太一個私人空間，以免其幻覺影響到其他病友',
      B: '護理師必須了解幻覺是精神分裂症的症狀之一，所以在與薛太太會談時儘量不要討論幻覺症狀，以免加重其症狀',
      C: '最好每天更換不同的護理師，以增加薛太太的刺激，才不致於一直沉浸在幻覺中',
      D: '主動關懷薛太太的需要，並提供協助',
    },
    answer: 'D',
  },
]

const fp = path.join(BACKEND, 'questions-nursing.json')
const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
const arr = data.questions || data
const existing = new Set(arr.map(q => `${q.exam_code}|${q.subject}|${q.number}`))
const maxId = arr.reduce((m, q) => Math.max(m, parseInt(String(q.id).replace(/\D/g, '')) || 0), 0)
let nextId = maxId + 1
let added = 0
for (const e of ENTRIES) {
  const k = `${e.code}|${e.subject}|${e.number}`
  if (existing.has(k)) { console.log(`skip ${k} (exists)`); continue }
  arr.push({
    id: nextId++,
    roc_year: e.year, session: e.sess, exam_code: e.code,
    subject: e.subject, subject_tag: e.tag, subject_name: e.subject,
    stage_id: 0, number: e.number,
    question: e.question, options: e.options, answer: e.answer,
    explanation: '',
  })
  existing.add(k); added++
  console.log(`+ ${e.year}-${e.sess} ${e.subject} #${e.number}`)
}
arr.sort((a, b) => {
  if (a.exam_code !== b.exam_code) return String(a.exam_code).localeCompare(String(b.exam_code))
  if (a.subject !== b.subject) return String(a.subject).localeCompare(String(b.subject))
  return (a.number || 0) - (b.number || 0)
})
fs.writeFileSync(fp, JSON.stringify(data, null, 2))
console.log(`\nTOTAL +${added}`)
