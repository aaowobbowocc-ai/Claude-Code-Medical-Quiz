#!/usr/bin/env node
// Re-scrape vet 102-105 using line-oriented parser.
// Existing data has ~223 scattered gaps from numeric-option parser failures.

const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

const QUESTIONS = path.join(__dirname, '..', 'questions-vet.json')

const SUBJECTS = [
  { s: '11', subject: '獸醫病理學', tag: 'vet_pathology', code: '1307' },
  { s: '22', subject: '獸醫藥理學', tag: 'vet_pharmacology', code: '2307' },
  { s: '33', subject: '獸醫實驗診斷學', tag: 'vet_lab_diagnosis', code: '3307' },
  { s: '44', subject: '獸醫普通疾病學', tag: 'vet_common_disease', code: '4307' },
  { s: '55', subject: '獸醫傳染病學', tag: 'vet_infectious', code: '5307' },
  { s: '66', subject: '獸醫公共衛生學', tag: 'vet_public_health', code: '6307' },
]

const SESSIONS = [
  { year: '102', session: '第一次', code: '102020', c: '307' },
  { year: '102', session: '第二次', code: '102100', c: '307' },
  { year: '103', session: '第一次', code: '103020', c: '307' },
  { year: '103', session: '第二次', code: '103090', c: '307' },
  { year: '104', session: '第一次', code: '104020', c: '307' },
  { year: '104', session: '第二次', code: '104090', c: '307' },
  // 105 年 020 系列 c-code 大換位，獸醫師移到 c=314
  { year: '105', session: '第一次', code: '105020', c: '314' },
  { year: '105', session: '第二次', code: '105100', c: '314' },
]

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, res => {
      if (res.statusCode === 302) return reject(new Error('302'))
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
  })
}

function parseQuestions(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  // Find first question: either "1." alone or "1.<text>"
  let i = lines.findIndex(l => /^1\.(\s|$)/.test(l) || l === '1.')
  if (i < 0) return []
  const qs = []
  const qNumRe = /^(\d{1,3})\.(.*)$/
  const matchNext = (line, expected) => {
    const m = line.match(qNumRe)
    if (!m) return null
    const n = parseInt(m[1])
    if (n !== expected) return null
    // Reject false positives: "A.1" handled already via option matcher running first
    return { num: n, inline: m[2].trim() }
  }
  while (i < lines.length) {
    const expected = qs.length ? qs[qs.length - 1].num + 1 : 1
    const mNum = matchNext(lines[i], expected)
    if (!mNum) break
    const num = mNum.num
    i++
    const buckets = { stem: [], A: [], B: [], C: [], D: [] }
    let cur = 'stem'
    if (mNum.inline) buckets.stem.push(mNum.inline)
    while (i < lines.length) {
      const l = lines[i]
      const mNext = matchNext(l, num + 1)
      if (mNext) break
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

function parseAnswers(text, subjectName) {
  const idx = text.indexOf('科目名稱：' + subjectName)
  if (idx < 0) return { answers: [], disputed: new Set(), corrections: {} }
  const section = text.slice(idx, idx + 1200)
  const rows = section.match(/答案[A-D#＃]+/g) || []
  const r1 = (rows[0] || '').replace('答案', '')
  const r2 = (rows[1] || '').replace('答案', '')
  const answers = new Array(80).fill('')
  for (let i = 0; i < 60 && i < r1.length; i++) answers[i] = r1[i]
  for (let i = 0; i < 10 && i < r2.length; i++) answers[70 + i] = r2[i]
  for (let i = 0; i < 10 && 10 + i < r2.length; i++) answers[60 + i] = r2[10 + i]

  const disputed = new Set()
  const corrections = {}
  const noteMatch = section.match(/備註:([^\n]+)/)
  if (noteMatch) {
    const items = noteMatch[1].split(/[，,]/)
    for (const item of items) {
      const mAll = item.match(/第(\d+)題一律給分/)
      if (mAll) { disputed.add(parseInt(mAll[1])); continue }
      const mDual = item.match(/第(\d+)題答([ABCD])[、,．]([ABCD])給分/)
      if (mDual) {
        disputed.add(parseInt(mDual[1]))
        corrections[parseInt(mDual[1])] = mDual[2]
      }
    }
  }
  return { answers, disputed, corrections }
}

async function scrapeSession(sess) {
  const results = []
  const aBuf = await download(`https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=A&code=${sess.code}&c=${sess.c}&s=11&q=1`)
  const aText = (await pdfParse(aBuf)).text

  for (const sub of SUBJECTS) {
    const qUrl = `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=Q&code=${sess.code}&c=${sess.c}&s=${sub.s}&q=1`
    let qBuf
    try { qBuf = await download(qUrl) } catch (e) { console.warn('SKIP', sess.code, sub.s, e.message); continue }
    const qText = (await pdfParse(qBuf)).text

    const parsed = parseQuestions(qText)
    const { answers, disputed, corrections } = parseAnswers(aText, sub.subject)

    const entries = parsed.map(p => {
      const raw = answers[p.num - 1]
      const ans = corrections[p.num] || (raw === '#' || raw === '＃' || !raw ? 'A' : raw)
      const q = {
        id: `${sess.code}_${sub.s}_${p.num}`,
        roc_year: sess.year,
        session: sess.session,
        exam_code: sess.code,
        subject: sub.subject,
        subject_tag: sub.tag,
        subject_name: sub.subject,
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
    const bad = entries.filter(e => !e.question || !e.options.A || !e.options.B || !e.options.C || !e.options.D)
    console.log(`${sess.year}-${sess.session} ${sub.subject}: ${entries.length} parsed, ${bad.length} bad`)
    results.push(...entries.filter(e => e.question && e.options.A && e.options.B && e.options.C && e.options.D))
  }
  return results
}

async function main() {
  const bank = JSON.parse(fs.readFileSync(QUESTIONS, 'utf8'))
  const arr = bank.questions || bank
  const before = arr.length

  const newEntries = []
  for (const sess of SESSIONS) {
    console.log(`\n=== ${sess.year}-${sess.session} (${sess.code}) ===`)
    const got = await scrapeSession(sess)
    newEntries.push(...got)
  }

  // Remove existing 102-105 entries, add new
  const keep = arr.filter(x => !(
    ['102', '103', '104', '105'].includes(x.roc_year) &&
    (x.subject_tag || '').startsWith('vet_')
  ))
  const removed = arr.length - keep.length
  const merged = keep.concat(newEntries)

  console.log(`\nRemoved ${removed} old, added ${newEntries.length} new`)
  console.log(`Total: ${before} → ${merged.length} (${merged.length - before >= 0 ? '+' : ''}${merged.length - before})`)

  if (bank.questions) bank.questions = merged
  const tmp = QUESTIONS + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(bank.questions ? bank : merged, null, 2))
  fs.renameSync(tmp, QUESTIONS)
  console.log('Wrote', QUESTIONS)
}

main().catch(e => { console.error(e); process.exit(1) })
