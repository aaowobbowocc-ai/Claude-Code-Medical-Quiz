#!/usr/bin/env node
/**
 * Fix-gaps-old-030: Re-parse 030-series PDFs to fill missing questions
 * from column-parser failures in the original scrape.
 *
 * Targets:
 *   doctor2 103年 第一次 醫學(四): Q3-9, 34-42 missing (code=103030, c=102, s=0104)
 *   doctor2 103年 第二次 醫學(四): Q3-9, 34-42 missing (code=103100, c=102, s=0104)
 *   tcm2    103年 第一次 中醫臨床(一): 40/80 (code=103030, c=110, s=0101)
 *   tcm2    103年 第一次 中醫臨床(二): 40/80 (code=103030, c=110, s=0102)
 *   nutrition 109年 第一次 團體膳食:  Q11,19-28 missing (code=109030, c=102, s=0202)
 */

const fs   = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')
const { parseColumnAware, parseAnswersText } = require('./lib/moex-column-parser')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const DIR  = path.join(__dirname, '..')

const TARGETS = [
  {
    file: 'questions-doctor2.json',
    year: '103', session: '第一次', subject: '醫學(四)', tag: 'pediatrics',
    code: '103030', c: '102', s: '0104',
  },
  {
    file: 'questions-doctor2.json',
    year: '103', session: '第二次', subject: '醫學(四)', tag: 'pediatrics',
    code: '103100', c: '102', s: '0104',
  },
  {
    file: 'questions-tcm2.json',
    year: '103', session: '第一次', subject: '中醫臨床醫學(一)', tag: 'tcm_clinical_1',
    code: '103030', c: '110', s: '0101',
  },
  {
    file: 'questions-tcm2.json',
    year: '103', session: '第一次', subject: '中醫臨床醫學(二)', tag: 'tcm_clinical_2',
    code: '103030', c: '110', s: '0102',
  },
  {
    file: 'questions-nutrition.json',
    year: '109', session: '第一次', subject: '團體膳食設計與管理', tag: 'group_meal',
    code: '109030', c: '102', s: '0202',
  },
]

// ---------- helpers ----------

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 25000,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/pdf,*/*',
        'Referer': 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx',
      },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location
        if (!loc || !loc.startsWith('http')) { res.resume(); return reject(new Error('bad redirect to ' + loc)) }
        return fetchPdf(loc, retries).then(resolve, reject)
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
      const cs = []
      res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    })
    req.on('error', e => retries > 0
      ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 1200)
      : reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function buildUrl(t, code, c, s) {
  return `${BASE}?t=${t}&code=${code}&c=${c}&s=${s}&q=1`
}

function stripPUA(s) { return s.replace(/[\uE000-\uF8FF]/g, '') }

// Simple answer parser for 030-series (half-width ABC format)
function parseAnswers030(rawText) {
  const text = stripPUA(rawText)
  const answers = {}

  // Try full-width format first
  const fullWidth = /答案\s*([ＡＢＣＤａｂｃｄABCD]+)/g
  let m, n = 1
  while ((m = fullWidth.exec(text)) !== null) {
    for (const ch of m[1]) {
      const map = { 'Ａ':'A','Ｂ':'B','Ｃ':'C','Ｄ':'D','ａ':'a','ｂ':'b','ｃ':'c','ｄ':'d',
                    'A':'A','B':'B','C':'C','D':'D','a':'A','b':'B','c':'C','d':'D' }
      if (map[ch]) answers[n++] = map[ch]
    }
  }
  if (Object.keys(answers).length >= 20) return answers

  // Half-width consecutive (100-105 answer format)
  const hw = /答案\s*([ABCDabcd]+)/g
  n = 1
  while ((m = hw.exec(text)) !== null) {
    for (const ch of m[1]) {
      if (/[ABCDabcd]/.test(ch)) answers[n++] = ch.toUpperCase()
    }
  }
  if (Object.keys(answers).length >= 20) return answers

  // Numbered answers
  const numbered = /(\d{1,2})\s*[.:]\s*([A-D])/gi
  while ((m = numbered.exec(text)) !== null) {
    const num = parseInt(m[1])
    if (num >= 1 && num <= 80) answers[num] = m[2].toUpperCase()
  }
  return answers
}

// Simple text parser fallback
function parseQuestionsText(rawText) {
  const text = stripPUA(rawText)
  const questions = []
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  let cur = null, opt = null, buf = ''

  const flushOpt = () => { if (cur && opt) cur.options[opt] = buf.trim(); buf = ''; opt = null }
  const flushQ = () => {
    flushOpt()
    if (cur && cur.question && Object.keys(cur.options).length >= 2) questions.push(cur)
    cur = null
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^(代號|類科|科目|考試|頁次|等\s*別|全.*題|本試題|座號|※)/.test(line)) continue
    if (/^\d+\s*頁/.test(line) || /^第\s*\d+\s*頁/.test(line)) continue

    const qm = line.match(/^(\d{1,2})[.、．]\s*(.*)$/)
    if (qm && !/^\d+\.\d/.test(line)) {
      const num = parseInt(qm[1])
      const isFirst = !cur && questions.length === 0
      if (num >= 1 && num <= 80 && (isFirst || (cur && num === cur.number + 1))) {
        flushQ()
        cur = { number: num, question: (qm[2] || '').trim(), options: {} }
        continue
      }
    }

    const om = line.match(/^[\(（]\s*([A-Da-dＡＢＣＤ])\s*[\)）]\s*(.*)$/)
      || line.match(/^([A-Da-dＡＢＣＤ])\s*[.．、]\s*(.*)$/)
    if (om && cur) {
      flushOpt()
      const raw2 = om[1]
      opt = raw2 === 'Ａ' ? 'A' : raw2 === 'Ｂ' ? 'B' : raw2 === 'Ｃ' ? 'C' : raw2 === 'Ｄ' ? 'D' : raw2.toUpperCase()
      buf = om[2] || ''
      continue
    }

    if (opt) buf += ' ' + line
    else if (cur) cur.question += ' ' + line
  }
  flushQ()
  return questions
}

function parseCorrectionsPdf(rawText) {
  const text = stripPUA(rawText)
  const corrections = {}
  for (const line of text.split(/\n/)) {
    const give = line.match(/第?\s*(\d{1,2})\s*題.*(?:一律給分|送分)/i)
    if (give) { corrections[parseInt(give[1])] = '*'; continue }
    const change = line.match(/第?\s*(\d{1,2})\s*題.*更正.*([A-D])/i)
    if (change) { corrections[parseInt(change[1])] = change[2]; continue }
  }
  return corrections
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- main ----------

async function main() {
  // Load all question files
  const files = {}
  const uniqueFiles = [...new Set(TARGETS.map(t => t.file))]
  for (const f of uniqueFiles) {
    const fp = path.join(DIR, f)
    files[f] = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  }

  let totalAdded = 0
  const issues = []

  for (const target of TARGETS) {
    const { file, year, session, subject, tag, code, c, s } = target
    console.log(`\n=== ${file} ${year}年${session} ${subject} (${code} c=${c} s=${s}) ===`)

    const data = files[file]
    const qs = Array.isArray(data) ? data : (data.questions || [])

    // Find existing questions for this paper
    const existing = qs.filter(q =>
      q.roc_year === year && q.session === session && q.subject === subject
    )
    const existingNums = new Set(existing.map(q => q.number))
    console.log(`  existing: ${existing.length}, nums: ${Math.min(...existingNums)}-${Math.max(...existingNums)}`)

    // Download PDFs
    const qUrl = buildUrl('Q', code, c, s)
    const aUrl = buildUrl('S', code, c, s)
    const mUrl = buildUrl('M', code, c, s)

    let qBuf, answers = {}, corrections = {}

    try {
      qBuf = await fetchPdf(qUrl)
    } catch (e) {
      console.error(`  ✗ Q PDF: ${e.message}`)
      issues.push(`${code} ${subject}: Q PDF failed`)
      continue
    }

    try {
      const aBuf = await fetchPdf(aUrl)
      const aText = stripPUA((await pdfParse(aBuf)).text)
      answers = parseAnswers030(aText)
    } catch (e) {
      console.error(`  ⚠ Answer PDF: ${e.message}`)
    }

    try {
      const mBuf = await fetchPdf(mUrl)
      corrections = parseCorrectionsPdf(stripPUA((await pdfParse(mBuf)).text))
      if (Object.keys(corrections).length) console.log(`  📝 ${Object.keys(corrections).length} corrections`)
    } catch { /* normal */ }

    const disputedNums = new Set()
    for (const [num, ans] of Object.entries(corrections)) {
      if (ans === '*') disputedNums.add(parseInt(num))
      else answers[parseInt(num)] = ans
    }

    // Parse questions via column-aware (primary) or text (fallback)
    let parsedMap = {}
    try {
      parsedMap = await parseColumnAware(qBuf)
      console.log(`  column parser: ${Object.keys(parsedMap).length} Q`)
    } catch (e) {
      console.log(`  ⚠ Column parser failed: ${e.message}, trying text...`)
    }

    if (Object.keys(parsedMap).length < 10) {
      const qText = stripPUA((await pdfParse(qBuf)).text)
      const textParsed = parseQuestionsText(qText)
      if (textParsed.length > Object.keys(parsedMap).length) {
        parsedMap = {}
        for (const q of textParsed) parsedMap[q.number] = q
        console.log(`  text parser: ${Object.keys(parsedMap).length} Q`)
      }
    }

    // Find and add ONLY the missing questions
    let nextId = 0
    for (const q of qs) if (typeof q.id === 'number' && q.id > nextId) nextId = q.id
    nextId += 1

    const newQ = []
    for (const [numStr, q] of Object.entries(parsedMap)) {
      const num = parseInt(numStr)
      if (existingNums.has(num)) continue  // already have it
      const ans = answers[num]
      if (!ans) {
        console.log(`  ⚠ Q${num}: no answer`)
        continue
      }
      // Inherit exam_code from existing questions (if any), else use code
      const existSample = existing[0]
      const obj = {
        id: nextId++,
        roc_year: year,
        session,
        exam_code: code,
        subject,
        subject_tag: tag,
        subject_name: subject,
        stage_id: existSample?.stage_id ?? 0,
        number: num,
        question: q.question?.trim() || '',
        options: q.options || {},
        answer: ans,
        explanation: '',
      }
      if (disputedNums.has(num)) obj.disputed = true
      newQ.push(obj)
    }

    console.log(`  → adding ${newQ.length} missing questions (had ${existing.length}, parsed ${Object.keys(parsedMap).length})`)
    if (newQ.length === 0) {
      issues.push(`${code} ${subject}: no new questions found (parser may have same gaps)`)
    }

    // Splice into files[file]
    if (Array.isArray(data)) {
      files[file] = data.concat(newQ)
    } else {
      data.questions = data.questions.concat(newQ)
      data.total = data.questions.length
      if (!data.metadata) data.metadata = {}
      data.metadata.last_updated = new Date().toISOString()
    }
    totalAdded += newQ.length

    await sleep(500)
  }

  // Write all changed files
  for (const f of uniqueFiles) {
    const fp = path.join(DIR, f)
    fs.writeFileSync(fp, JSON.stringify(files[f], null, 2), 'utf-8')
    const total = Array.isArray(files[f]) ? files[f].length : files[f].total
    console.log(`\n✅ ${f}: total ${total}`)
  }

  console.log(`\nTotal added: ${totalAdded}`)
  if (issues.length) { console.log('Issues:'); issues.forEach(i => console.log('  -', i)) }
}

main().catch(e => { console.error(e); process.exit(1) })
