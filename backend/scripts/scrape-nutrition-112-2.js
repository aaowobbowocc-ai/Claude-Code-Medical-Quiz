#!/usr/bin/env node
// One-shot: fill nutrition 112 第二次
// code=112110, c=101 (NOT 102), s=0101..0106
// PDF format: no period after question number, PUA glyphs for ABCD markers
// Answer PDF: tabular layout, extract all A/B/C/D sequentially

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 25000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*',
                 Referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800)
        return reject(new Error('redirect'))
      }
      if (res.statusCode !== 200) {
        res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800)
        return reject(new Error('HTTP ' + res.statusCode))
      }
      const ct = res.headers['content-type'] || ''
      if (!ct.includes('pdf') && !ct.includes('octet')) { res.resume(); return reject(new Error('not PDF: ' + ct)) }
      const cs = []
      res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    })
    req.on('error', e => retries > 0 ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800) : reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

// PUA mapping: e18c=A, e18d=B, e18e=C, e18f=D
const PUA_MAP = { '\uE18C': 'A', '\uE18D': 'B', '\uE18E': 'C', '\uE18F': 'D' }

function parseQuestionsPUA(text) {
  // Step 1: Replace PUA option markers with normalized markers
  let norm = text
  for (const [pua, letter] of Object.entries(PUA_MAP)) {
    norm = norm.replaceAll(pua, `\n@@${letter}@@`)
  }
  // Strip remaining PUA
  norm = norm.replace(/[\uE000-\uF8FF]/g, '')

  const lines = norm.replace(/\r\n/g, '\n').split('\n')
  const questions = []
  let cur = null, opt = null, buf = ''

  const flushOpt = () => { if (cur && opt) cur.options[opt] = buf.trim(); buf = ''; opt = null }
  const flushQ = () => {
    flushOpt()
    if (cur && cur.question && Object.keys(cur.options).length >= 2) questions.push(cur)
    cur = null
  }

  let started = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    // Skip header lines
    if (/^(代\s*號|類\s*科|科\s*目|考試|頁次|等\s*別|全.*題|本試題|座號|※|甲、|乙、|不必抄|請以|本科目|共\d+題|禁止|測驗題|單一選擇)/.test(line)) {
      if (/測驗題|單一選擇/.test(line)) started = true
      continue
    }
    if (/^第?\s*\d+\s*頁/.test(line)) continue
    // Skip essay section markers
    if (/^[一二三四五六七八九十]+、/.test(line) && !started) continue

    // Option marker line: @@A@@text
    const optMatch = line.match(/^@@([ABCD])@@\s*(.*)$/)
    if (optMatch && cur) {
      flushOpt()
      opt = optMatch[1]
      buf = optMatch[2] || ''
      continue
    }

    // Question number: digit(s) directly followed by content (no period separator)
    // Use expected-number matching to avoid greedy digit ambiguity
    // e.g. "211分子葡萄糖..." is Q21 text "1分子葡萄糖", not Q211
    if (started) {
      const expectedNum = cur ? cur.number + 1 : 1
      const expectedStr = String(expectedNum)
      if (line.startsWith(expectedStr) && line.length > expectedStr.length) {
        const rest = line.slice(expectedStr.length)
        // Expected-number matching resolves digit ambiguity (e.g. "211分子" → Q21 "1分子")
        if (!rest.startsWith('年')) {
          flushQ()
          cur = { number: expectedNum, question: rest.trim(), options: {} }
          continue
        }
      }
    }

    // Also try standard format (digit + period) as fallback
    const qm2 = line.match(/^(\d{1,3})[.、．]\s*(.*)$/)
    if (qm2) {
      const num = parseInt(qm2[1])
      const isFirst = !cur && questions.length === 0
      if (num >= 1 && num <= 120 && (isFirst || (cur && num === cur.number + 1))) {
        flushQ()
        cur = { number: num, question: (qm2[2] || '').trim(), options: {} }
        started = true
        continue
      }
    }

    // Continuation text
    if (opt) buf += ' ' + line
    else if (cur) cur.question += ' ' + line
  }
  flushQ()
  return questions
}

function parseAnswersPUA(text) {
  const answers = {}

  // Try standard fullwidth format first
  const fw = /答案\s*([ＡＢＣＤ]+)/g
  let m, n = 1
  while ((m = fw.exec(text)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) answers[n++] = k
    }
  }
  if (Object.keys(answers).length >= 20) return answers

  // Tabular format: strip 題號 patterns, extract all remaining A/B/C/D sequentially
  // Remove "第N題" patterns and "題號" / "答案" / "標準答案" headers
  let cleaned = text
    .replace(/第\d{1,3}題/g, '')
    .replace(/題號/g, '')
    .replace(/答案/g, '')
    .replace(/標準/g, '')
    .replace(/複選題數[：:][^\n]*/g, '')
    .replace(/複選每題配分[：:][^\n]*/g, '')
    .replace(/備[\s　]*註[：:][^\n]*/g, '')
    .replace(/[\s\n\r]+/g, '')

  // Extract all A/B/C/D chars
  let idx = 1
  for (const ch of cleaned) {
    if (ch === 'A' || ch === 'B' || ch === 'C' || ch === 'D') {
      answers[idx++] = ch
    }
  }

  return answers
}

const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s
const sleep = ms => new Promise(r => setTimeout(r, ms))

function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')) }
function atomicWrite(p, obj) {
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, p)
}

async function main() {
  console.log('\n=== nutrition 112 第二次 (code=112110, c=101, PUA parser) ===')
  const SUBJECTS = [
    { s: '0101', name: '生理學與生物化學', tag: 'physio_biochem' },
    { s: '0102', name: '營養學', tag: 'nutrition_science' },
    { s: '0103', name: '膳食療養學', tag: 'diet_therapy' },
    { s: '0104', name: '團體膳食設計與管理', tag: 'group_meal' },
    { s: '0105', name: '公共衛生營養學', tag: 'public_nutrition' },
    { s: '0106', name: '食品衛生與安全', tag: 'food_safety' },
  ]
  const code = '112110', c = '101', year = '112', session = '第二次'
  const file = path.join(__dirname, '..', 'questions-nutrition.json')
  const data = loadJson(file)
  const existingKey = new Set(data.questions.map(q => `${q.exam_code}_${q.number}_${q.subject_tag}`))
  let nextId = Math.max(...data.questions.map(q => q.id || 0)) + 1
  const added = []

  for (const sub of SUBJECTS) {
    const qUrl = `${BASE}?t=Q&code=${code}&c=${c}&s=${sub.s}&q=1`
    const aUrl = `${BASE}?t=S&code=${code}&c=${c}&s=${sub.s}&q=1`
    let qText, aText

    try {
      const qBuf = await fetchPdf(qUrl)
      qText = (await pdfParse(qBuf)).text
    } catch (e) {
      console.log(`  ✗ ${sub.name}: Q fetch failed — ${e.message}`)
      continue
    }
    try {
      const aBuf = await fetchPdf(aUrl)
      aText = (await pdfParse(aBuf)).text
    } catch (e) {
      console.log(`  ⚠ ${sub.name}: no answer PDF — ${e.message}`)
      aText = ''
    }

    const parsed = parseQuestionsPUA(qText)
    const answers = parseAnswersPUA(aText)
    console.log(`  ✓ ${sub.name}: ${parsed.length} Q / ${Object.keys(answers).length} A`)

    for (const q of parsed) {
      const ans = answers[q.number]
      if (!ans) continue
      const key = `${code}_${q.number}_${sub.tag}`
      if (existingKey.has(key)) continue
      const cleanOpts = {}
      for (const k of ['A', 'B', 'C', 'D']) cleanOpts[k] = stripPUA(q.options[k] || '')
      added.push({
        id: nextId++, roc_year: year, session, exam_code: code,
        subject: sub.name, subject_tag: sub.tag, subject_name: sub.name,
        stage_id: 0, number: q.number,
        question: stripPUA(q.question), options: cleanOpts,
        answer: ans, explanation: '',
      })
    }
    await sleep(400)
  }

  if (added.length === 0) { console.log('  (nothing to add)'); return }
  data.questions.push(...added)
  data.total = data.questions.length
  atomicWrite(file, data)
  console.log(`\n  ✅ +${added.length} questions → ${data.questions.length} total`)
}

main().catch(e => { console.error(e); process.exit(1) })
