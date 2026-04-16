#!/usr/bin/env node
// Scrape 律師/司法官 第一試 (110-114, 5 years)
// PUA-based PDF format: e18c=A, e18d=B, e18e=C, e18f=D
// No period after question numbers

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

const PUA_MAP = { '\uE18C': 'A', '\uE18D': 'B', '\uE18E': 'C', '\uE18F': 'D' }

function parseQuestionsPUA(text) {
  let norm = text
  for (const [pua, letter] of Object.entries(PUA_MAP)) {
    norm = norm.replaceAll(pua, '\n@@' + letter + '@@')
  }
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

    if (/^(代\s*號|類\s*科|科\s*目|考試|頁次|等\s*別|全.*題|本試題|座號|※|甲、|乙、|不必抄|請以|本科目|共\d+題|禁止|測驗題|單一選擇)/.test(line)) {
      if (/測驗題|單一選擇/.test(line)) started = true
      continue
    }
    if (/^第?\s*\d+\s*頁/.test(line)) continue

    // Option marker
    const optMatch = line.match(/^@@([ABCD])@@\s*(.*)$/)
    if (optMatch && cur) {
      flushOpt()
      opt = optMatch[1]
      buf = optMatch[2] || ''
      continue
    }

    // Expected-number question matching
    if (started) {
      const expectedNum = cur ? cur.number + 1 : 1
      const expectedStr = String(expectedNum)
      if (line.startsWith(expectedStr) && line.length > expectedStr.length) {
        const rest = line.slice(expectedStr.length)
        // Block year headers like "112年第二次..." or "111年公務人員..." but allow questions starting with 年 like "年僅17歲..."
        if (!/^年\s*(第|公務|專門|國家|特種)/.test(rest)) {
          flushQ()
          cur = { number: expectedNum, question: rest.trim(), options: {} }
          continue
        }
      }
    }

    // Also try standard format (digit + period) as fallback
    const qm2 = line.match(/^(\d{1,3})[.、．]\s*(.*)$/)
    if (qm2 && started) {
      const num = parseInt(qm2[1])
      const isFirst = !cur && questions.length === 0
      if (num >= 1 && num <= 120 && (isFirst || (cur && num === cur.number + 1))) {
        flushQ()
        cur = { number: num, question: (qm2[2] || '').trim(), options: {} }
        continue
      }
    }

    if (opt) buf += ' ' + line
    else if (cur) cur.question += ' ' + line
  }
  flushQ()
  return questions
}

function parseAnswersPUA(text) {
  const answers = {}

  // Try fullwidth format first
  const fw = /答案\s*([ＡＢＣＤ]+)/g
  let m, n = 1
  while ((m = fw.exec(text)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) answers[n++] = k
    }
  }
  if (Object.keys(answers).length >= 20) return answers

  // Tabular format: strip 題號 patterns, extract sequential A/B/C/D
  let cleaned = text
    .replace(/第\d{1,3}題/g, '')
    .replace(/題號/g, '').replace(/答案/g, '').replace(/標準/g, '')
    .replace(/複選題數[：:][^\n]*/g, '').replace(/複選每題配分[：:][^\n]*/g, '')
    .replace(/備[\s　]*註[：:][^\n]*/g, '')
    .replace(/[\s\n\r]+/g, '')

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

function atomicWrite(p, obj) {
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, p)
}

async function main() {
  const SESSIONS = [
    { year: '105', code: '105110', session: '第一次' },
    { year: '106', code: '106120', session: '第一次' },
    { year: '107', code: '107120', session: '第一次' },
    { year: '108', code: '108120', session: '第一次' },
    { year: '109', code: '109120', session: '第一次' },
    { year: '110', code: '110120', session: '第一次' },
    { year: '111', code: '111120', session: '第一次' },
    { year: '112', code: '112120', session: '第一次' },
    { year: '113', code: '113110', session: '第一次' },
    { year: '114', code: '114110', session: '第一次' },
  ]
  const SUBJECTS = [
    { s: '0101', name: '綜合法學（憲法、行政法、國際公法、國際私法）', tag: 'comprehensive_law_1' },
    { s: '0201', name: '綜合法學（民法、民事訴訟法）', tag: 'comprehensive_law_2' },
    { s: '0202', name: '綜合法學（公司法、保險法、票據法、證券交易法、強制執行法、法學英文）', tag: 'comprehensive_law_3' },
    { s: '0301', name: '綜合法學（刑法、刑事訴訟法、法律倫理）', tag: 'comprehensive_law_4' },
  ]
  const c = '301'
  const file = path.join(__dirname, '..', 'questions-lawyer1.json')

  // Initialize or load
  let data
  if (fs.existsSync(file)) {
    data = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } else {
    data = { total: 0, questions: [] }
  }
  const existingKey = new Set(data.questions.map(q => `${q.exam_code}_${q.number}_${q.subject_tag}`))
  let nextId = data.questions.length > 0 ? Math.max(...data.questions.map(q => q.id || 0)) + 1 : 1
  const added = []

  for (const sess of SESSIONS) {
    console.log(`\n--- ${sess.year} ${sess.session} (${sess.code}) ---`)
    for (const sub of SUBJECTS) {
      const qUrl = `${BASE}?t=Q&code=${sess.code}&c=${c}&s=${sub.s}&q=1`
      const aUrl = `${BASE}?t=S&code=${sess.code}&c=${c}&s=${sub.s}&q=1`
      let qText, aText

      try {
        const qBuf = await fetchPdf(qUrl)
        qText = (await pdfParse(qBuf)).text
      } catch (e) {
        console.log(`  ✗ ${sub.name}: ${e.message}`)
        continue
      }
      try {
        const aBuf = await fetchPdf(aUrl)
        aText = (await pdfParse(aBuf)).text
      } catch (e) {
        console.log(`  ⚠ ${sub.name} no answers: ${e.message}`)
        aText = ''
      }

      const parsed = parseQuestionsPUA(qText)
      const answers = parseAnswersPUA(aText)
      console.log(`  ✓ ${sub.tag}: ${parsed.length} Q / ${Object.keys(answers).length} A`)

      for (const q of parsed) {
        const ans = answers[q.number]
        if (!ans) continue
        const key = `${sess.code}_${q.number}_${sub.tag}`
        if (existingKey.has(key)) continue
        const cleanOpts = {}
        for (const k of ['A', 'B', 'C', 'D']) cleanOpts[k] = stripPUA(q.options[k] || '')
        added.push({
          id: nextId++, roc_year: sess.year, session: sess.session, exam_code: sess.code,
          subject: sub.name, subject_tag: sub.tag, subject_name: sub.name,
          stage_id: 0, number: q.number,
          question: stripPUA(q.question), options: cleanOpts,
          answer: ans, explanation: '',
        })
      }
      await sleep(400)
    }
    await sleep(500)
  }

  if (added.length === 0) { console.log('\n(nothing to add)'); return }
  data.questions.push(...added)
  data.total = data.questions.length
  atomicWrite(file, data)
  console.log(`\n✅ +${added.length} questions → ${data.questions.length} total`)
}

main().catch(e => { console.error(e); process.exit(1) })
