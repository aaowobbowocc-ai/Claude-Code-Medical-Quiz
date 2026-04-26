#!/usr/bin/env node
/**
 * scrape-pharma1-paper3-gap.js — 補藥師一階 106-109 卷三 (s=33, c=305)
 *
 * 舊爬蟲只爬了 s=11(卷一) 和 s=22(卷二)，遺漏 s=33(卷三：藥劑學與生物藥劑學)
 * 共 8 場次 × 80 題 = 640 題
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const fs = require('fs')
const path = require('path')
const { fetchPdf, cachedFetch, buildMoexUrl } = require('./lib/pdf-fetcher')
const https = require('https')
const pdfParse = require('pdf-parse')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const JSON_FILE = path.join(__dirname, '..', 'questions-pharma1.json')

const SESSIONS = [
  { year: '106', session: '第一次', code: '106020' },
  { year: '106', session: '第二次', code: '106100' },
  { year: '107', session: '第一次', code: '107020' },
  { year: '107', session: '第二次', code: '107100' },
  { year: '108', session: '第一次', code: '108030' },
  { year: '108', session: '第二次', code: '108100' },
  { year: '109', session: '第一次', code: '109020' },
  { year: '109', session: '第二次', code: '109100' },
]

const CLASS_CODE = '305'
const SUBJECT_CODE = '33'
const SUBJECT = '卷三'
const SUBJECT_TAG = 'pharmaceutics'  // 藥劑學 tag
const SUBJECT_NAME = '藥學(三)(包括藥劑學與生物藥劑學)'


function parseQuestions(text) {
  const questions = []
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  let currentQ = null
  let currentOpt = null
  let buffer = ''

  const flushOpt = () => {
    if (currentQ && currentOpt) currentQ.options[currentOpt] = buffer.trim()
    buffer = ''; currentOpt = null
  }
  const flushQ = () => {
    flushOpt()
    if (currentQ && currentQ.question && Object.keys(currentQ.options).length >= 2) {
      questions.push(currentQ)
    }
    currentQ = null
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^(代\s*號|類\s*科|科\s*目|考試|頁次|等\s*別|全.*題|本試題|座號|※|【|】)/.test(line)) continue
    if (/^第?\s*\d+\s*頁/.test(line)) continue
    if (/^\d{3}.*專技/.test(line)) continue

    const qMatch = line.match(/^(\d{1,3})[.、．]\s*(.*)$/)
    if (qMatch) {
      const num = parseInt(qMatch[1])
      const rest = (qMatch[2] || '').trim()
      const looksLikeQ = rest === '' || /[\u4e00-\u9fff a-zA-Z（(]/.test(rest)
      if (looksLikeQ && num >= 1 && num <= 100) {
        if (!currentQ || num === currentQ.number + 1 || (num === 1 && !currentQ)) {
          flushQ()
          currentQ = { number: num, question: rest, options: {} }
          continue
        }
      }
    }

    const optMatch = line.match(/^([A-D])[.、．]\s*(.*)$/)
    if (optMatch && currentQ) {
      flushOpt()
      currentOpt = optMatch[1]
      buffer = optMatch[2] || ''
      continue
    }

    if (currentOpt) {
      buffer += (buffer ? ' ' : '') + line
    } else if (currentQ) {
      currentQ.question += ' ' + line
    }
  }
  flushQ()
  return questions
}

function parseAnswers(text) {
  const answers = []
  const map = { 'Ａ': 'A', 'Ｂ': 'B', 'Ｃ': 'C', 'Ｄ': 'D' }
  const re = /[ＡＢＣＤ]/g
  let m
  while ((m = re.exec(text)) !== null) answers.push(map[m[0]])
  return answers
}

const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s

async function main() {
  const raw = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'))
  const existing = raw.questions || []
  console.log(`Existing pharma1 questions: ${existing.length}`)

  const existingIds = new Set(existing.map(q => `${q.roc_year}|${q.session}|${q.subject_tag}|${q.number}`))
  let totalAdded = 0

  for (const sess of SESSIONS) {
    console.log(`\n--- ${sess.year} ${sess.session} (${sess.code}) ---`)

    let questions, answers, corrections = {}

    try {
      const qBuf = await fetchPdf(`${BASE}?t=Q&code=${sess.code}&c=${CLASS_CODE}&s=${SUBJECT_CODE}&q=1`)
      const qText = (await pdfParse(qBuf)).text
      questions = parseQuestions(qText)
      console.log(`  Parsed ${questions.length} questions`)
    } catch (e) {
      console.log(`  ❌ Question PDF failed: ${e.message}`)
      continue
    }

    try {
      const aBuf = await fetchPdf(`${BASE}?t=S&code=${sess.code}&c=${CLASS_CODE}&s=${SUBJECT_CODE}&q=1`)
      const aText = (await pdfParse(aBuf)).text
      answers = parseAnswers(aText)
      console.log(`  Parsed ${answers.length} answers`)
    } catch (e) {
      console.log(`  ❌ Answer PDF failed: ${e.message}`)
      continue
    }

    try {
      const mBuf = await fetchPdf(`${BASE}?t=M&code=${sess.code}&c=${CLASS_CODE}&s=${SUBJECT_CODE}&q=1`)
      const mText = (await pdfParse(mBuf)).text
      for (const line of mText.split(/\n/)) {
        const give = line.match(/第?\s*(\d{1,3})\s*題.*(?:一律給分|送分)/i)
        if (give) { corrections[parseInt(give[1])] = '*'; continue }
        const change = line.match(/第?\s*(\d{1,3})\s*題.*更正.*([ＡＢＣＤA-D])/i)
        if (change) {
          let ch = change[2]
          if (ch === 'Ａ') ch = 'A'; else if (ch === 'Ｂ') ch = 'B'
          else if (ch === 'Ｃ') ch = 'C'; else if (ch === 'Ｄ') ch = 'D'
          corrections[parseInt(change[1])] = ch
        }
      }
      if (Object.keys(corrections).length) console.log(`  Corrections: ${JSON.stringify(corrections)}`)
    } catch { console.log('  No corrections PDF') }

    let added = 0
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      let ans = answers[i] || null
      if (!ans) continue

      if (corrections[q.number] && corrections[q.number] !== '*') {
        ans = corrections[q.number]
      }

      const dupKey = `${sess.year}|${sess.session}|${SUBJECT_TAG}|${q.number}`
      if (existingIds.has(dupKey)) continue

      existing.push({
        id: `${sess.code}_s${SUBJECT_CODE}_${q.number}`,
        roc_year: sess.year,
        session: sess.session,
        exam_code: sess.code,
        subject: SUBJECT,
        subject_tag: SUBJECT_TAG,
        subject_name: SUBJECT_NAME,
        stage_id: 0,
        number: q.number,
        question: stripPUA(q.question),
        options: {
          A: stripPUA(q.options.A),
          B: stripPUA(q.options.B),
          C: stripPUA(q.options.C),
          D: stripPUA(q.options.D),
        },
        answer: ans,
        explanation: '',
        ...(corrections[q.number] === '*' ? { disputed: true } : {}),
      })
      existingIds.add(dupKey)
      added++
    }

    console.log(`  Added: ${added}`)
    totalAdded += added
  }

  console.log(`\nTotal added: ${totalAdded}`)
  console.log(`New total: ${existing.length}`)

  // Sort
  existing.sort((a, b) => {
    const yc = (a.roc_year || '').localeCompare(b.roc_year || '')
    if (yc) return yc
    const sc = (a.session || '').localeCompare(b.session || '')
    if (sc) return sc
    const tc = (a.subject_tag || '').localeCompare(b.subject_tag || '')
    if (tc) return tc
    return (a.number || 0) - (b.number || 0)
  })

  raw.questions = existing
  const tmp = JSON_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf-8')
  fs.renameSync(tmp, JSON_FILE)
  console.log('Written to', JSON_FILE)
}

main().catch(e => { console.error(e); process.exit(1) })
