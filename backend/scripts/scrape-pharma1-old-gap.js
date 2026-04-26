#!/usr/bin/env node
/**
 * scrape-pharma1-old-gap.js — 補藥師(一) 106-109 年缺漏的 s=11, s=22 兩科
 *
 * 原本 scrape-moex-old.js 只抓了 s=33（藥劑學），漏了：
 *   s=11 → 藥理學與藥物化學
 *   s=22 → 藥物分析與生藥學(包括中藥學)
 *
 * 8 場次 × 2 科 × ~80 題 ≈ 640 題
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const fs = require('fs')
const path = require('path')
const { fetchPdf, cachedFetch, buildMoexUrl } = require('./lib/pdf-fetcher')
const https = require('https')
const pdfParse = require('pdf-parse')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const PHARMA1_JSON = path.join(__dirname, '..', 'questions-pharma1.json')
const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')

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

// Subjects missing from old scrape (s=33 already captured)
const SUBJECTS = [
  { s: '11', subject: '藥理學與藥物化學',               tag: 'pharmacology' },
  { s: '22', subject: '藥物分析與生藥學(包括中藥學)',     tag: 'pharmaceutical_analysis' },
]

const CLASS_CODE = '305'


async function cachedPdf(kind, code, s) {
  fs.mkdirSync(PDF_CACHE, { recursive: true })
  const fname = `pharma1_${kind}_${code}_c${CLASS_CODE}_s${s}.pdf`
  const fp = path.join(PDF_CACHE, fname)
  if (fs.existsSync(fp) && fs.statSync(fp).size > 1000) return fs.readFileSync(fp)
  const url = `${BASE}?t=${kind}&code=${code}&c=${CLASS_CODE}&s=${s}&q=1`
  const buf = await fetchPdf(url)
  fs.writeFileSync(fp, buf)
  return buf
}

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
    if (/^106|^107|^108|^109|年.*專門職業/.test(line)) continue

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
  // Full-width ABCD answers: 答案ＡＢＣＤ...
  const fullWidthRe = /[ＡＢＣＤ]/g
  const map = { 'Ａ': 'A', 'Ｂ': 'B', 'Ｃ': 'C', 'Ｄ': 'D' }
  let m
  while ((m = fullWidthRe.exec(text)) !== null) {
    answers.push(map[m[0]])
  }
  return answers
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(PHARMA1_JSON, 'utf8'))
  const existing = raw.questions || []
  console.log(`Existing pharma1 questions: ${existing.length}`)

  // Build set of existing IDs to avoid dupes
  const existingIds = new Set(existing.map(q => String(q.id)))
  let totalAdded = 0

  for (const sess of SESSIONS) {
    for (const subj of SUBJECTS) {
      const prefix = `${sess.code}_${subj.s}`
      process.stdout.write(`  ${sess.year} ${sess.session} ${subj.subject}...`)

      try {
        const qBuf = await cachedPdf('Q', sess.code, subj.s)
        const qText = (await pdfParse(qBuf)).text
        const questions = parseQuestions(qText)

        const aBuf = await cachedPdf('S', sess.code, subj.s)
        const aText = (await pdfParse(aBuf)).text
        const answers = parseAnswers(aText)

        let added = 0
        for (let i = 0; i < questions.length; i++) {
          const q = questions[i]
          const ans = answers[i] || null
          if (!ans) continue

          const id = `${sess.code}_s${subj.s}_${q.number}`
          if (existingIds.has(id)) continue

          existing.push({
            id,
            roc_year: sess.year,
            session: sess.session,
            exam_code: sess.code,
            subject: subj.subject,
            subject_tag: subj.tag,
            subject_name: subj.subject,
            stage_id: 0,
            number: q.number,
            question: q.question,
            options: q.options,
            answer: ans,
            explanation: '',
          })
          existingIds.add(id)
          added++
        }

        console.log(` ${questions.length} Q, ${answers.length} A, +${added}`)
        totalAdded += added
      } catch (e) {
        console.log(` ERROR: ${e.message}`)
      }
    }
  }

  console.log(`\nTotal added: ${totalAdded}`)
  console.log(`New total: ${existing.length}`)

  // Sort by year, session, subject, number
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
  const tmp = PHARMA1_JSON + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf-8')
  fs.renameSync(tmp, PHARMA1_JSON)
  console.log('Written to', PHARMA1_JSON)
}

main().catch(e => { console.error(e); process.exit(1) })
