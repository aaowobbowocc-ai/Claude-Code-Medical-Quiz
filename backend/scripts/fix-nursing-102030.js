#!/usr/bin/env node
/**
 * 修 102030 nursing：
 *  1. 從真實 PDF (c=110 s=0601-0604) 解析 4 卷 × 80 題 = 320 題
 *  2. 移除 nursing.json 中所有 exam_code='102030' 條目 (400 筆污染)
 *  3. 插入新解析的 320 真實 nursing 題目
 *
 * 同時下載 + 解析答案 PDF (t=S)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')
const { parseQuestions, parseAnswers, stripPUA } = require('./lib/pdf-question-parser')
const { parseColumnAware, parseAnswersColumnAware } = require('./lib/moex-column-parser')

const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

const PAPERS = [
  { s: '0601', subject: '基本護理學與護理行政', tag: 'fundamental_nursing' },
  { s: '0602', subject: '內外科護理學',          tag: 'internal_nursing' },
  { s: '0603', subject: '產兒科護理學',          tag: 'obstetric_nursing' },
  { s: '0604', subject: '精神科與社區衛生護理學', tag: 'psychiatric_nursing' },
]

function get(url) {
  return new Promise(r => {
    https.get(url, x => {
      if (x.statusCode !== 200) return r(null);
      const c=[]; x.on('data',d=>c.push(d)); x.on('end',()=>r(Buffer.concat(c)));
    }).on('error', () => r(null));
  });
}

async function fetchCached(kind, s) {
  const file = path.join(PDF_CACHE, `${kind}_102030_c110_s${s}.pdf`)
  if (fs.existsSync(file)) return fs.readFileSync(file)
  const url = `${BASE}?t=${kind}&code=102030&c=110&s=${s}&q=1`
  const buf = await get(url)
  if (buf && buf.length > 1000) {
    fs.writeFileSync(file, buf)
    return buf
  }
  return null
}

async function main() {
  const fp = path.join(__dirname, '..', 'questions-nursing.json')
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data

  // 1. Build new entries from PDFs
  const newEntries = []
  let nextId = arr.reduce((m, q) => Math.max(m, parseInt(String(q.id).replace(/\D/g, '')) || 0), 0) + 1
  for (const p of PAPERS) {
    const qBuf = await fetchCached('Q', p.s)
    const aBuf = await fetchCached('S', p.s)
    if (!qBuf || !aBuf) { console.log(`✗ ${p.subject}: PDF missing`); continue }
    const qText = (await pdfParse(qBuf)).text
    const aText = (await pdfParse(aBuf)).text
    let questions = parseQuestions(qText, { maxQNum: 80 })
    if (questions.length < 20) {
      // 改用 column-aware (100-105 CBT 格式)
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
        id: `102030_${p.tag}_${q.number}`,
        roc_year: '102',
        session: '第一次',
        exam_code: '102030',
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
  console.log(`\nNew entries: ${newEntries.length}`)

  if (newEntries.length < 200) {
    console.log('Not enough — abort to avoid losing data')
    return
  }

  // 2. Remove all old 102030 entries (400 polluted)
  const before = arr.length
  const filtered = arr.filter(q => q.exam_code !== '102030')
  console.log(`Removed polluted: ${before - filtered.length}`)

  // 3. Insert new
  filtered.push(...newEntries)
  filtered.sort((a, b) => {
    if (a.exam_code !== b.exam_code) return String(a.exam_code).localeCompare(String(b.exam_code))
    if (a.subject !== b.subject) return String(a.subject).localeCompare(String(b.subject))
    return (a.number || 0) - (b.number || 0)
  })
  if (data.questions) data.questions = filtered
  fs.writeFileSync(fp, JSON.stringify(data.questions ? data : filtered, null, 2))
  console.log(`\nFinal nursing.json: ${filtered.length} (was ${before}, delta ${filtered.length - before})`)
}

main().catch(e => { console.error(e); process.exit(1) })
