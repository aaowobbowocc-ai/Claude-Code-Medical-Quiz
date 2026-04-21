#!/usr/bin/env node
// Fill OT 102-2 小兒職能治療學 — currently only 6/80 questions.
// Uses line-oriented parser (column-aware parser returned 0).

const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

const QUESTIONS = path.join(__dirname, '..', 'questions-ot.json')
const URL_Q = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=Q&code=102100&c=305&s=55&q=1'
const URL_A = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=A&code=102100&c=305&s=55&q=1'

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, res => {
      if (res.statusCode === 302) return reject(new Error('302 ' + res.headers.location))
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
  })
}

function parseQuestions(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  let i = lines.findIndex(l => l === '1.')
  const qs = []
  while (i < lines.length) {
    const mNum = lines[i].match(/^(\d{1,2})\.$/)
    if (!mNum) break
    const num = parseInt(mNum[1])
    i++
    const buckets = { stem: [], A: [], B: [], C: [], D: [] }
    let cur = 'stem'
    while (i < lines.length) {
      const l = lines[i]
      if (/^(\d{1,2})\.$/.test(l) && parseInt(l) === num + 1) break
      const mOpt = l.match(/^([ABCD])\.(.*)$/)
      if (mOpt) {
        const exp = { stem: 'A', A: 'B', B: 'C', C: 'D' }[cur]
        if (mOpt[1] === exp) {
          cur = mOpt[1]
          if (mOpt[2]) buckets[cur].push(mOpt[2])
          i++
          continue
        }
      }
      buckets[cur].push(l)
      i++
    }
    qs.push({
      num,
      question: buckets.stem.join(''),
      options: { A: buckets.A.join(''), B: buckets.B.join(''), C: buckets.C.join(''), D: buckets.D.join('') },
    })
  }
  return qs
}

function parseAnswers(text) {
  const idx = text.indexOf('小兒職能治療學')
  const section = text.slice(idx, idx + 600)
  const rows = section.match(/答案[A-D#]+/g) || []
  const r1 = (rows[0] || '').replace('答案', '')      // Q01-60
  const r2 = (rows[1] || '').replace('答案', '')      // Q71-80 + Q61-70
  const answers = new Array(80).fill('')
  for (let i = 0; i < 60; i++) answers[i] = r1[i] || ''
  for (let i = 0; i < 10; i++) answers[70 + i] = r2[i] || ''
  for (let i = 0; i < 10; i++) answers[60 + i] = r2[10 + i] || ''

  const disputed = new Set()
  const corrections = {}
  const noteMatch = section.match(/備註:(.+?)(?=\n|$)/)
  if (noteMatch) {
    const note = noteMatch[1]
    const items = note.split(/[，,]/)
    for (const item of items) {
      const mAll = item.match(/第(\d+)題一律給分/)
      if (mAll) {
        disputed.add(parseInt(mAll[1]))
        continue
      }
      const mDual = item.match(/第(\d+)題答([ABCD])、([ABCD])給分/)
      if (mDual) {
        const n = parseInt(mDual[1])
        disputed.add(n)
        corrections[n] = mDual[2]
      }
    }
  }
  return { answers, disputed, corrections }
}

async function main() {
  const [qBuf, aBuf] = await Promise.all([download(URL_Q), download(URL_A)])
  const qText = (await pdfParse(qBuf)).text
  const aText = (await pdfParse(aBuf)).text

  const parsed = parseQuestions(qText)
  const { answers, disputed, corrections } = parseAnswers(aText)

  console.log('Parsed', parsed.length, 'questions')
  console.log('Disputed:', [...disputed].sort((a, b) => a - b))

  const newQs = parsed.map(p => {
    const ans = corrections[p.num] || (answers[p.num - 1] === '#' ? 'A' : answers[p.num - 1])
    const q = {
      id: `102100-ot-55-${p.num}`,
      roc_year: '102',
      session: '第二次',
      exam_code: '102100',
      subject: '小兒疾病職能治療學',
      subject_tag: 'ot_pediatric',
      subject_name: '小兒疾病職能治療學',
      stage_id: 0,
      number: p.num,
      question: p.question,
      options: p.options,
      answer: ans,
      explanation: '',
    }
    if (disputed.has(p.num)) q.disputed = true
    return q
  })

  const bankFile = fs.readFileSync(QUESTIONS, 'utf8')
  const bank = JSON.parse(bankFile)
  const arr = bank.questions || bank

  // Remove existing 102-2 小兒 entries
  const before = arr.length
  const keep = arr.filter(x => !(
    x.roc_year === '102' &&
    x.session === '第二次' &&
    (x.subject === '小兒疾病職能治療學' || x.subject_name === '小兒疾病職能治療學')
  ))
  console.log('Removed', before - keep.length, 'stale 102-2 小兒 entries')

  const merged = keep.concat(newQs)
  if (bank.questions) bank.questions = merged
  else Object.assign(bank, merged)

  const tmp = QUESTIONS + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(bank.questions ? bank : merged, null, 2))
  fs.renameSync(tmp, QUESTIONS)
  console.log('Wrote', merged.length, 'total questions')
}

main().catch(e => { console.error(e); process.exit(1) })
