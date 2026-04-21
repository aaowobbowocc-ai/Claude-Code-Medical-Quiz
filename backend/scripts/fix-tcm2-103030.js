#!/usr/bin/env node
/**
 * Fix TCM2 103030 — remove corrupted data and re-scrape all four papers
 *
 * Root cause: scrape-100-105.js used wrong class codes for 103030:
 *   Wrong: c=110 s=0601/0602 = 社工師
 *   Wrong: c=109 s=0503/0504 = 護理師
 *   Correct: c=104 s=0203-0206 = 中醫臨床醫學(一)-(四)
 *
 * This script:
 *   1. Removes ALL existing exam_code=103030 questions from questions-tcm2.json
 *   2. Scrapes fresh from the correct URLs
 */

const fs   = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')
const { parseColumnAware, stripPUA } = require('./lib/moex-column-parser')

const OUT_FILE = path.join(__dirname, '..', 'questions-tcm2.json')
const BASE_URL = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const PAPERS = [
  { s: '0203', subject: '中醫臨床醫學(一)', subjectTag: 'tcm_clinical_1' },
  { s: '0204', subject: '中醫臨床醫學(二)', subjectTag: 'tcm_clinical_2' },
  { s: '0205', subject: '中醫臨床醫學(三)', subjectTag: 'tcm_clinical_3' },
  { s: '0206', subject: '中醫臨床醫學(四)', subjectTag: 'tcm_clinical_4' },
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const opts = {
      rejectUnauthorized: false,
      timeout: 30000,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/pdf,*/*',
        'Referer': 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx',
      },
    }
    const req = https.get(url, opts, res => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        const loc = res.headers.location || ''
        res.resume()
        if (loc.startsWith('http')) return fetchPdf(loc, retries).then(resolve, reject)
        return reject(new Error(`Redirect to ${loc}`))
      }
      if (res.statusCode !== 200) {
        res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 2000)
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', e => {
      if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 2000)
      reject(e)
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function parseAnswersHalfWidth(text) {
  // 100-105 year format: 題號 答案ABCD... (half-width, every 20 Q per line)
  const ans = {}
  let n = 1
  const re = /答案\s*([A-DＡＢＣＤ]+)/g
  let m
  while ((m = re.exec(text)) !== null) {
    for (const ch of m[1]) {
      const map = { 'Ａ': 'A', 'Ｂ': 'B', 'Ｃ': 'C', 'Ｄ': 'D', A: 'A', B: 'B', C: 'C', D: 'D' }
      if (map[ch]) ans[n++] = map[ch]
    }
  }
  return ans
}

async function main() {
  const data = JSON.parse(fs.readFileSync(OUT_FILE, 'utf-8'))
  const qs = Array.isArray(data) ? data : (data.questions || [])

  // Remove ALL existing 103030 questions (they are corrupted — wrong exam content)
  const before = qs.filter(q => q.exam_code === '103030')
  console.log(`Removing ${before.length} corrupted 103030 questions...`)
  const cleaned = qs.filter(q => q.exam_code !== '103030')
  console.log(`Questions after removal: ${cleaned.length}`)

  let nextId = 0
  for (const q of cleaned) if (typeof q.id === 'number' && q.id > nextId) nextId = q.id
  nextId++
  console.log(`Next ID: ${nextId}`)

  const newQuestions = []

  for (const paper of PAPERS) {
    console.log(`\n--- ${paper.subject} (c=104 s=${paper.s}) ---`)

    const qUrl = `${BASE_URL}?t=Q&code=103030&c=104&s=${paper.s}&q=1`
    const aUrl = `${BASE_URL}?t=S&code=103030&c=104&s=${paper.s}&q=1`

    let qParsed, answers
    try {
      const qBuf = await fetchPdf(qUrl)
      console.log(`Q PDF: ${qBuf.length} bytes`)
      qParsed = await parseColumnAware(qBuf)
      const nums = Object.keys(qParsed).map(Number).sort((a, b) => a - b)
      console.log(`Column parser: ${nums.length} questions, range ${nums[0]}-${nums[nums.length - 1]}`)
    } catch (e) {
      console.error(`Q PDF failed: ${e.message}`)
      continue
    }

    await sleep(2000)

    try {
      const aBuf = await fetchPdf(aUrl)
      const aText = stripPUA((await pdfParse(aBuf)).text)
      answers = parseAnswersHalfWidth(aText)
      console.log(`Answers: ${Object.keys(answers).length}`)
    } catch (e) {
      console.error(`A PDF failed: ${e.message} — cannot proceed for this paper`)
      continue
    }

    let added = 0
    for (const [numStr, q] of Object.entries(qParsed)) {
      const num = parseInt(numStr)
      const ans = answers[num]
      if (!ans) {
        console.log(`  No answer for Q${num}, skipping`)
        continue
      }

      newQuestions.push({
        id: nextId++,
        roc_year: '103',
        session: '第一次',
        exam_code: '103030',
        subject: paper.subject,
        subject_tag: paper.subjectTag,
        subject_name: paper.subject,
        stage_id: 0,
        number: num,
        question: q.question.trim(),
        options: q.options,
        answer: ans,
        explanation: '',
      })
      added++
    }
    console.log(`Added: ${added}`)
    await sleep(2500)
  }

  console.log(`\nTotal new questions: ${newQuestions.length}`)

  const allQs = cleaned.concat(newQuestions)
  const out = Array.isArray(data) ? allQs : { ...data, questions: allQs, total: allQs.length }
  if (!Array.isArray(out) && !out.metadata) out.metadata = {}
  if (!Array.isArray(out)) out.metadata.last_updated = new Date().toISOString()

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), 'utf-8')
  console.log(`✅ Wrote ${allQs.length} total questions (removed ${before.length} corrupt, added ${newQuestions.length})`)
}

main().catch(e => { console.error(e); process.exit(1) })
