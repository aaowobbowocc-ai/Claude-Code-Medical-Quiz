#!/usr/bin/env node
/**
 * One-shot: scrape 醫師一階 105/106/107 年第一次
 *
 * Discovery (2026-04-18):
 *   These years use non-standard subject codes s=55 (醫學一) and s=66 (醫學二)
 *   instead of the usual s=11 / s=22.  Some sessions are partial (CBT for one paper):
 *     105020 c=301: s=55 (醫學一) → 302 NOT available, s=66 (醫學二) → 200 OK
 *     106020 c=301: s=55 (醫學一) → 200 OK,               s=66 (醫學二) → 302 NOT available
 *     107020 c=301: s=55 (醫學一) → 200 OK,               s=66 (醫學二) → 200 OK
 */

const fs   = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

const BASE_URL  = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const OUT_FILE  = path.join(__dirname, '..', 'questions.json')

const SESSIONS = [
  {
    year: '105', code: '105020', session: '第一次',
    papers: [
      // s=55 (醫學一) is CBT → skip; s=66 (醫學二) is PDF
      { s: '66', subject: '醫學(二)', tag: 'pathology' },
    ],
  },
  {
    year: '106', code: '106020', session: '第一次',
    papers: [
      // s=55 (醫學一) is PDF; s=66 (醫學二) is CBT → skip
      { s: '55', subject: '醫學(一)', tag: 'anatomy' },
    ],
  },
  {
    year: '107', code: '107020', session: '第一次',
    papers: [
      { s: '55', subject: '醫學(一)', tag: 'anatomy' },
      { s: '66', subject: '醫學(二)', tag: 'pathology' },
    ],
  },
]

// ---------- HTTP helpers ----------

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const opts = {
      rejectUnauthorized: false,
      timeout: 25000,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/pdf,*/*',
        'Referer': 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx',
      },
    }
    const req = https.get(url, opts, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        const loc = res.headers.location
        if (!loc || !loc.startsWith('http')) {
          res.resume()
          return reject(new Error(`Redirect to ${loc}`))
        }
        return fetchPdf(loc, retries).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 1200)
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
      if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 1200)
      reject(e)
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function buildUrl(t, code, s) {
  return `${BASE_URL}?t=${t}&code=${code}&c=301&s=${s}&q=1`
}

// ---------- PDF parsers ----------

function stripPUA(s) {
  return s.replace(/[\uE000-\uF8FF]/g, '')
}

function parseQuestionsPdf(rawText) {
  const text = stripPUA(rawText)
  const questions = []
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  let currentQ   = null
  let currentOpt = null
  let buffer     = ''

  function flushOpt() {
    if (currentQ && currentOpt) currentQ.options[currentOpt] = buffer.trim()
    buffer = ''; currentOpt = null
  }
  function flushQ() {
    flushOpt()
    if (currentQ && currentQ.question && Object.keys(currentQ.options).length >= 2)
      questions.push(currentQ)
    currentQ = null
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^(代號|類科|科目|考試|頁次|等\s*別|全.*題|本試題|座號|※)/.test(line)) continue
    if (/^\d+\s*頁/.test(line) || /^第\s*\d+\s*頁/.test(line)) continue

    const qMatch = line.match(/^(\d{1,3})[.、．]\s*(.*)$/)
    if (qMatch && !/^\d+\.\d/.test(line)) {
      const num = parseInt(qMatch[1])
      const isFirst = !currentQ && questions.length === 0
      if (num >= 1 && num <= 100 && (isFirst || (currentQ && num === currentQ.number + 1))) {
        flushQ()
        currentQ = { number: num, question: (qMatch[2] || '').trim(), options: {} }
        continue
      }
    }

    const optMatch = line.match(/^[\(（]\s*([A-Da-dＡＢＣＤ])\s*[\)）]\s*(.*)$/)
      || line.match(/^([A-Da-dＡＢＣＤ])\s*[.．、]\s*(.*)$/)
    if (optMatch && currentQ) {
      flushOpt()
      const raw = optMatch[1]
      currentOpt = raw === 'Ａ' ? 'A' : raw === 'Ｂ' ? 'B' : raw === 'Ｃ' ? 'C' : raw === 'Ｄ' ? 'D' : raw.toUpperCase()
      buffer = optMatch[2] || ''
      continue
    }

    if (currentOpt) buffer += ' ' + line
    else if (currentQ) currentQ.question += ' ' + line
  }
  flushQ()
  return questions
}

function parseAnswersPdf(rawText) {
  const text = stripPUA(rawText)
  const answers = {}
  const fullWidth = /答案\s*([ＡＢＣＤabcdABCD]+)/g
  let m
  let n = 1
  while ((m = fullWidth.exec(text)) !== null) {
    for (const ch of m[1]) {
      const map = { 'Ａ':'A','Ｂ':'B','Ｃ':'C','Ｄ':'D','a':'A','b':'B','c':'C','d':'D',
                    'A':'A','B':'B','C':'C','D':'D' }
      if (map[ch]) answers[n++] = map[ch]
    }
  }
  if (Object.keys(answers).length >= 20) return answers
  const hw = /(\d{1,3})\s*[.\s、．:：]\s*([A-Da-d])/g
  let hw2
  while ((hw2 = hw.exec(text)) !== null) {
    const num = parseInt(hw2[1])
    if (num >= 1 && num <= 100) answers[num] = hw2[2].toUpperCase()
  }
  return answers
}

function parseCorrectionsPdf(rawText) {
  const text = stripPUA(rawText)
  const corrections = {}
  for (const line of text.split(/\n/)) {
    const give = line.match(/第?\s*(\d{1,3})\s*題.*(?:一律給分|送分)/i)
    if (give) { corrections[parseInt(give[1])] = '*'; continue }
    const change = line.match(/第?\s*(\d{1,3})\s*題.*更正.*([A-D])/i)
    if (change) { corrections[parseInt(change[1])] = change[2]; continue }
  }
  return corrections
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- main ----------

async function main() {
  const data = JSON.parse(fs.readFileSync(OUT_FILE, 'utf-8'))
  const qs   = Array.isArray(data) ? data : (data.questions || [])

  // Guard against duplicates
  const existCodes = new Set(qs.map(q => q.exam_code + '_' + q.session).filter(Boolean))
  for (const sess of SESSIONS) {
    const key = sess.code + '_' + sess.session
    if (existCodes.has(key)) {
      console.error(`✗ Questions for ${sess.code} ${sess.session} already exist. Aborting.`)
      process.exit(1)
    }
  }

  let nextId = 0
  for (const q of qs) if (typeof q.id === 'number' && q.id > nextId) nextId = q.id
  nextId += 1
  console.log(`Starting ids at ${nextId}`)

  const newQuestions = []
  const issues = []

  for (const sess of SESSIONS) {
    console.log(`\n=== ${sess.year}年${sess.session} (${sess.code}) ===`)
    for (const paper of sess.papers) {
      console.log(`  --- ${paper.subject} s=${paper.s} ---`)
      const qUrl = buildUrl('Q', sess.code, paper.s)
      const aUrl = buildUrl('S', sess.code, paper.s)
      const mUrl = buildUrl('M', sess.code, paper.s)

      let qText
      try {
        qText = (await pdfParse(await fetchPdf(qUrl))).text
      } catch (e) {
        console.error(`  ✗ Q PDF: ${e.message}`)
        issues.push(`${sess.code} ${paper.subject}: Q PDF failed — ${e.message}`)
        continue
      }

      let answers = {}
      try {
        answers = parseAnswersPdf((await pdfParse(await fetchPdf(aUrl))).text)
      } catch (e) {
        console.error(`  ⚠ Answer PDF: ${e.message}`)
        issues.push(`${sess.code} ${paper.subject}: Answer PDF failed — ${e.message}`)
      }

      let corrections = {}
      try {
        corrections = parseCorrectionsPdf((await pdfParse(await fetchPdf(mUrl))).text)
        if (Object.keys(corrections).length) console.log(`  📝 ${Object.keys(corrections).length} corrections`)
      } catch { /* no correction PDF is normal */ }

      const disputedNums = new Set()
      for (const [num, ans] of Object.entries(corrections)) {
        if (ans === '*') disputedNums.add(parseInt(num))
        else answers[parseInt(num)] = ans
      }

      const parsed = parseQuestionsPdf(qText)
      console.log(`  parsed: ${parsed.length} Q, answers: ${Object.keys(answers).length}`)
      if (parsed.length < 50) issues.push(`${sess.code} ${paper.subject}: only ${parsed.length} questions parsed`)

      let kept = 0
      for (const q of parsed) {
        const ans = answers[q.number]
        if (!ans) continue
        const obj = {
          id: nextId++,
          roc_year: sess.year,
          session: sess.session,
          exam_code: sess.code,
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
      console.log(`  ✓ kept ${kept}`)
      await sleep(400)
    }
  }

  console.log(`\n====================================`)
  console.log(`Total new: ${newQuestions.length}`)
  if (issues.length) { console.log('Issues:'); issues.forEach(i => console.log('  -', i)) }

  if (!newQuestions.length) { console.error('No questions scraped. Aborting.'); process.exit(1) }

  const allQs = qs.concat(newQuestions)
  const out = Array.isArray(data) ? allQs : { ...data, questions: allQs, total: allQs.length }
  if (!Array.isArray(out) && !out.metadata) out.metadata = {}
  if (!Array.isArray(out)) out.metadata.last_updated = new Date().toISOString()

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), 'utf-8')
  console.log(`\n✅ Wrote ${allQs.length} total (added ${newQuestions.length}) to questions.json`)
}

main().catch(e => { console.error(e); process.exit(1) })
