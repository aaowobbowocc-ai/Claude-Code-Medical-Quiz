#!/usr/bin/env node
/**
 * 修 102110 nursing：跟 102030 同問題（5 卷含「基礎醫學」其實是污染）
 * 從 c=109 s=0501-0504 抓 4 卷真實題目
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')
const { parseColumnAware, parseAnswersColumnAware } = require('./lib/moex-column-parser')
const { parseQuestions, parseAnswers, stripPUA } = require('./lib/pdf-question-parser')

const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')

const PAPERS = [
  { s: '0501', subject: '基本護理學與護理行政', tag: 'fundamental_nursing' },
  { s: '0502', subject: '內外科護理學',          tag: 'internal_nursing' },
  { s: '0503', subject: '產兒科護理學',          tag: 'obstetric_nursing' },
  { s: '0504', subject: '精神科與社區衛生護理學', tag: 'psychiatric_nursing' },
]

async function main() {
  const fp = path.join(__dirname, '..', 'questions-nursing.json')
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data

  const newEntries = []
  let maxId = arr.reduce((m, q) => Math.max(m, parseInt(String(q.id).replace(/\D/g, '')) || 0), 0)
  for (const p of PAPERS) {
    const qBuf = fs.readFileSync(path.join(PDF_CACHE, `Q_102110_c109_s${p.s}.pdf`))
    const aBuf = fs.readFileSync(path.join(PDF_CACHE, `S_102110_c109_s${p.s}.pdf`))
    const qText = (await pdfParse(qBuf)).text
    const aText = (await pdfParse(aBuf)).text
    let questions = parseQuestions(qText, { maxQNum: 80 })
    if (questions.length < 20) {
      const cols = await parseColumnAware(qBuf)
      if (cols) questions = Object.entries(cols).map(([n, q]) => ({ number: +n, ...q }))
    }
    let answers = parseAnswers(aText, { maxQNum: 80 })
    if (Object.keys(answers).length < 20) {
      const cols = await parseAnswersColumnAware(aBuf).catch(() => ({}))
      if (Object.keys(cols).length > Object.keys(answers).length) answers = cols
    }
    console.log(`${p.subject}: parsed ${questions.length}q, ${Object.keys(answers).length}a`)
    for (const q of questions) {
      const ans = answers[q.number]
      if (!ans || !'ABCD'.includes(ans)) continue
      const cleanOpts = {}
      for (const k of ['A','B','C','D']) cleanOpts[k] = stripPUA(q.options[k] || '')
      newEntries.push({
        id: `102110_${p.tag}_${q.number}`,
        roc_year: '102',
        session: '第二次',
        exam_code: '102110',
        subject: p.subject,
        subject_tag: p.tag,
        subject_name: p.subject,
        stage_id: 0,
        number: q.number,
        question: stripPUA(q.question || ''),
        options: cleanOpts,
        answer: ans,
        explanation: '',
      })
    }
  }
  console.log('\nNew entries:', newEntries.length)
  if (newEntries.length < 200) { console.log('Abort'); return }

  const before = arr.length
  const filtered = arr.filter(q => q.exam_code !== '102110')
  console.log('Removed polluted:', before - filtered.length)
  filtered.push(...newEntries)
  filtered.sort((a, b) => {
    if (a.exam_code !== b.exam_code) return String(a.exam_code).localeCompare(String(b.exam_code))
    if (a.subject !== b.subject) return String(a.subject).localeCompare(String(b.subject))
    return (a.number || 0) - (b.number || 0)
  })
  if (data.questions) data.questions = filtered
  fs.writeFileSync(fp, JSON.stringify(data.questions ? data : filtered, null, 2))
  console.log(`Final: ${filtered.length} (delta ${filtered.length - before})`)
}

main().catch(e => { console.error(e); process.exit(1) })
