#!/usr/bin/env node
/**
 * One-shot: scrape 醫師(二) 113年第二次 (code=113070, c=302)
 * Fills the gap in questions-doctor2.json (110-115 sessions, 113070 was missing).
 *
 * URL pattern (verified by user):
 *   ?t=Q&code=113070&c=302&s=11&q=1  → 醫學(三) internal_medicine
 *   ?t=Q&code=113070&c=302&s=22&q=1  → 醫學(四) pediatrics
 *   ?t=Q&code=113070&c=302&s=33&q=1  → 醫學(五) surgery
 *   ?t=Q&code=113070&c=302&s=44&q=1  → 醫學(六) medical_law_ethics
 *
 * Note: doctor2 uses 2-digit s codes (NOT 4-digit like nursing/pt).
 * Output schema matches the existing 114070 entries (numeric sequential id,
 * stage_id=0, subject_name = paper name, one tag per paper).
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

const EXAM_CODE = '113070'
const CLASS_CODE = '302'
const SESSION_LABEL = '第二次'
const ROC_YEAR = '113'

const PAPERS = [
  { s: '11', subject: '醫學(三)', tag: 'internal_medicine' },
  { s: '22', subject: '醫學(四)', tag: 'pediatrics' },
  { s: '33', subject: '醫學(五)', tag: 'surgery' },
  { s: '44', subject: '醫學(六)', tag: 'medical_law_ethics' },
]

const BASE_URL = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const opts = {
      rejectUnauthorized: false,
      timeout: 25000,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/pdf,*/*',
        'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx',
      },
    }
    const req = https.get(url, opts, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        const loc = res.headers.location
        if (loc && !loc.startsWith('http')) {
          res.resume()
          return reject(new Error(`Redirect to ${loc}`))
        }
        return fetchPdf(loc, retries).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        if (retries > 0) {
          return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 1000)
        }
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      const ct = res.headers['content-type'] || ''
      if (!ct.includes('pdf') && !ct.includes('octet')) {
        res.resume()
        return reject(new Error(`Not PDF: ${ct}`))
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', e => {
      if (retries > 0) {
        return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 1000)
      }
      reject(e)
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function buildUrl(t, s) {
  return `${BASE_URL}?t=${t}&code=${EXAM_CODE}&c=${CLASS_CODE}&s=${s}&q=1`
}

function parseQuestionsPdf(text) {
  const questions = []
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  let currentQ = null
  let currentOption = null
  let buffer = ''

  function flushOption() {
    if (currentQ && currentOption) {
      currentQ.options[currentOption] = buffer.trim()
    }
    buffer = ''
    currentOption = null
  }
  function flushQuestion() {
    flushOption()
    if (currentQ && currentQ.question && Object.keys(currentQ.options).length >= 2) {
      questions.push(currentQ)
    }
    currentQ = null
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^(代號|類科|科目|考試|頁次|等\s*別|全.*題|本試題|座號|※)/.test(line)) continue
    if (/^\d+\s*頁/.test(line)) continue
    if (/^第\s*\d+\s*頁/.test(line)) continue

    const qMatch = line.match(/^(\d{1,2})[.、．]\s*(.*)$/)
    if (qMatch && (line.length > 6 || /[\u4e00-\u9fff a-zA-Z]/.test(qMatch[2] || '') || (qMatch[2] || '') === '')) {
      const num = parseInt(qMatch[1])
      const isFirst = !currentQ && questions.length === 0
      if (num >= 1 && num <= 80 && (isFirst || (currentQ && num === currentQ.number + 1))) {
        flushQuestion()
        currentQ = { number: num, question: (qMatch[2] || '').trim(), options: {} }
        continue
      }
    }

    // Option marker must have an explicit separator (period or paren) — otherwise
    // option text starting with a letter ("atorvastatin") would be misparsed as option A.
    const optMatch = line.match(/^[\(（]\s*([A-Da-dＡＢＣＤ])\s*[\)）]\s*(.*)$/)
      || line.match(/^([A-Da-dＡＢＣＤ])\s*[.．、]\s*(.*)$/)
    if (optMatch && currentQ) {
      flushOption()
      currentOption = optMatch[1].toUpperCase()
        .replace('Ａ', 'A').replace('Ｂ', 'B').replace('Ｃ', 'C').replace('Ｄ', 'D')
      buffer = optMatch[2] || ''
      continue
    }

    if (currentOption) {
      buffer += ' ' + line
    } else if (currentQ) {
      currentQ.question += ' ' + line
    }
  }
  flushQuestion()
  return questions
}

function parseAnswersPdf(text) {
  const answers = {}
  const fullWidthPattern = /答案\s*([ＡＢＣＤ]+)/g
  let m
  let questionNum = 1
  while ((m = fullWidthPattern.exec(text)) !== null) {
    const letters = m[1]
    for (let i = 0; i < letters.length; i++) {
      const ch = letters[i]
      const mapped = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (mapped) answers[questionNum++] = mapped
    }
  }
  if (Object.keys(answers).length >= 20) return answers

  const hwPattern = /(\d{1,2})\s*[.\s、．:：]\s*([A-Da-d])/g
  let hw
  while ((hw = hwPattern.exec(text)) !== null) {
    const num = parseInt(hw[1])
    if (num >= 1 && num <= 80) answers[num] = hw[2].toUpperCase()
  }
  return answers
}

function parseCorrectionsPdf(text) {
  const corrections = {}
  const lines = text.split(/\n/)
  for (const line of lines) {
    const give = line.match(/第?\s*(\d{1,2})\s*題.*(?:一律給分|送分)/i)
    if (give) { corrections[parseInt(give[1])] = '*'; continue }
    const change = line.match(/第?\s*(\d{1,2})\s*題.*更正.*([A-D])/i)
    if (change) { corrections[parseInt(change[1])] = change[2]; continue }
    const simple = line.match(/(\d{1,2})\s+([A-D*])/gi)
    if (simple) {
      for (const s of simple) {
        const mm = s.match(/(\d{1,2})\s+([A-D*])/i)
        if (mm) corrections[parseInt(mm[1])] = mm[2].toUpperCase()
      }
    }
  }
  return corrections
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const outFile = path.join(__dirname, '..', 'questions-doctor2.json')
  const data = JSON.parse(fs.readFileSync(outFile, 'utf-8'))
  const qs = data.questions

  // Verify gap
  const existing = qs.filter(q => q.exam_code === EXAM_CODE)
  if (existing.length > 0) {
    console.error(`✗ ${existing.length} questions for ${EXAM_CODE} already exist. Aborting to avoid duplicates.`)
    process.exit(1)
  }

  // Compute next numeric id
  let nextId = 0
  for (const q of qs) if (typeof q.id === 'number' && q.id > nextId) nextId = q.id
  nextId += 1
  console.log(`Starting new ids at ${nextId}`)

  const newQuestions = []
  const issues = []

  for (const paper of PAPERS) {
    const qUrl = buildUrl('Q', paper.s)
    const aUrl = buildUrl('S', paper.s)
    const mUrl = buildUrl('M', paper.s)
    console.log(`\n--- ${paper.subject} (s=${paper.s}) ---`)

    let qText
    try {
      const buf = await fetchPdf(qUrl)
      qText = (await pdfParse(buf)).text
    } catch (e) {
      console.error(`  ✗ Q PDF: ${e.message}`)
      issues.push({ paper: paper.subject, error: 'Q PDF: ' + e.message })
      continue
    }

    let answers = {}
    try {
      const buf = await fetchPdf(aUrl)
      answers = parseAnswersPdf((await pdfParse(buf)).text)
    } catch (e) {
      console.error(`  ⚠ Answer PDF: ${e.message}`)
      issues.push({ paper: paper.subject, error: 'Answer PDF: ' + e.message })
    }

    let corrections = {}
    try {
      const buf = await fetchPdf(mUrl)
      corrections = parseCorrectionsPdf((await pdfParse(buf)).text)
      if (Object.keys(corrections).length > 0) {
        console.log(`  📝 ${Object.keys(corrections).length} corrections`)
      }
    } catch { /* normal */ }

    const disputedNums = new Set()
    for (const [num, ans] of Object.entries(corrections)) {
      if (ans === '*') disputedNums.add(parseInt(num))
      else answers[num] = ans
    }

    const parsed = parseQuestionsPdf(qText)
    console.log(`  parsed: ${parsed.length} questions, answers: ${Object.keys(answers).length}`)

    if (parsed.length !== 80) {
      issues.push({ paper: paper.subject, error: `Only ${parsed.length}/80 questions parsed` })
    }

    let kept = 0
    for (const q of parsed) {
      const ans = answers[q.number]
      if (!ans) continue
      const obj = {
        id: nextId++,
        roc_year: ROC_YEAR,
        session: SESSION_LABEL,
        exam_code: EXAM_CODE,
        subject: paper.subject,
        subject_tag: paper.tag,
        subject_name: paper.subject,
        stage_id: 0,
        number: q.number,
        question: q.question.trim(),
        options: q.options,
        answer: ans,
        explanation: '',
      }
      if (disputedNums.has(q.number)) obj.disputed = true
      newQuestions.push(obj)
      kept++
    }
    console.log(`  ✓ kept ${kept} questions`)

    await sleep(400)
  }

  console.log(`\n========================================`)
  console.log(`Total new: ${newQuestions.length} questions`)
  if (issues.length > 0) {
    console.log(`Issues:`)
    issues.forEach(i => console.log(`  - ${i.paper}: ${i.error}`))
  }

  if (newQuestions.length === 0) {
    console.error(`No questions scraped. Aborting write.`)
    process.exit(1)
  }

  // Append + write
  data.questions = qs.concat(newQuestions)
  data.total = data.questions.length
  if (!data.metadata) data.metadata = {}
  data.metadata.last_updated = new Date().toISOString()

  fs.writeFileSync(outFile, JSON.stringify(data, null, 2), 'utf-8')
  console.log(`\n✅ Wrote ${data.total} questions (added ${newQuestions.length}) to questions-doctor2.json`)
}

main().catch(e => { console.error(e); process.exit(1) })
