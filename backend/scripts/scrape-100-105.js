#!/usr/bin/env node
/**
 * Scrape 民國 100-105 年題目 — all medical exams.
 *
 * Class codes and session codes are COMPLETELY different from 106+ years.
 * This script has been built from exhaustive probing of 考選部's system.
 *
 * Usage:
 *   node scripts/scrape-100-105.js                    # all exams
 *   node scripts/scrape-100-105.js --exam doctor1     # single exam
 *   node scripts/scrape-100-105.js --exam nursing --year 105
 *   node scripts/scrape-100-105.js --dry-run          # list URLs only
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')
const { parseColumnAware, parseAnswersColumnAware, parseAnswersText, stripPUA } = require('./lib/moex-column-parser')
const { atomicWriteJson } = require('./lib/atomic-write')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache-100-105')
const BACKEND = path.resolve(__dirname, '..')

if (!fs.existsSync(PDF_CACHE)) fs.mkdirSync(PDF_CACHE, { recursive: true })

// ─── HTTP ───

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 20000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*',
                 Referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location
        if (!loc || !loc.startsWith('http')) { res.resume(); return reject(new Error('redirect')) }
        return fetchPdf(loc, retries).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 1000)
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      const ct = res.headers['content-type'] || ''
      if (!ct.includes('pdf') && !ct.includes('octet')) { res.resume(); return reject(new Error(`not PDF`)) }
      const cs = []
      res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
      res.on('error', e => retries > 0
        ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 1000)
        : reject(e))
    })
    req.on('error', e => retries > 0
      ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 1000)
      : reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function cachedPdf(kind, code, c, s) {
  const fpath = path.join(PDF_CACHE, `${kind}_${code}_c${c}_s${s}.pdf`)
  try {
    const buf = fs.readFileSync(fpath)
    if (buf.length > 1000) return { buf, fromCache: true }
  } catch {}
  const buf = await fetchPdf(`${BASE}?t=${kind}&code=${code}&c=${c}&s=${s}&q=1`)
  fs.writeFileSync(fpath, buf)
  return { buf, fromCache: false }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── Answer PDF parser (handles both fullwidth ＡＢＣＤ and halfwidth ABCD) ───

function parseAnswersPdf(text) {
  const answers = {}

  // Pattern 1: fullwidth 答案ＡＢＣＤ... (may include ＃ for corrected answers)
  const fwPattern = /答案\s*([ＡＢＣＤ＃]+)/g
  let m, n = 1
  while ((m = fwPattern.exec(text)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) answers[n++] = k
      else if (ch === '＃') n++ // corrected answer, skip position
    }
  }
  if (Object.keys(answers).length >= 20) return answers

  // Pattern 2: halfwidth 答案ABCD... (years 100-105 format)
  // Answers are concatenated: 答案ACCCDBCADB... (each char = one question)
  // '#' marks corrected answers (skip those)
  // Cap at 120 to avoid t=A combined PDFs blending other subjects' answers
  const hwConcat = /答案\s*([A-D#]{10,})/gi
  n = 1
  const hwAnswers = {}
  while ((m = hwConcat.exec(text)) !== null) {
    for (const ch of m[1]) {
      if (/[A-D]/i.test(ch) && n <= 120) hwAnswers[n] = ch.toUpperCase()
      n++ // '#' still increments position
    }
  }
  if (Object.keys(hwAnswers).length > Object.keys(answers).length) {
    return hwAnswers
  }

  // Pattern 3: numbered format "1. A  2. B  3. C"
  const numbered = /(\d{1,2})\s*[.\s、．:：]\s*([A-Da-d])/g
  while ((m = numbered.exec(text)) !== null) {
    const num = parseInt(m[1])
    if (num >= 1 && num <= 120) answers[num] = m[2].toUpperCase()
  }
  return answers
}

// ─── Corrections parser ───

function parseCorrectionsPdf(text) {
  const corrections = {}
  for (const line of text.split(/\n/)) {
    const give = line.match(/第?\s*(\d{1,2})\s*題.*(?:一律給分|送分)/i)
    if (give) { corrections[parseInt(give[1])] = '*'; continue }
    const change = line.match(/第?\s*(\d{1,2})\s*題.*更正.*([A-D])/i)
    if (change) { corrections[parseInt(change[1])] = change[2]; continue }
    // Table format: "1  A" or "23  *" (some PDFs use tabular layout)
    const tbl = line.match(/^(\d{1,2})\s+([A-D*＊])$/)
    if (tbl) { corrections[parseInt(tbl[1])] = tbl[2] === '＊' ? '*' : tbl[2]; continue }
  }
  return corrections
}

// ─── Question parser (labeled format: 1. question, (A)/(B)/(C)/(D)) ───

function parseQuestions(text) {
  const questions = []
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  let cur = null, opt = null, buf = ''
  let inMcSection = false

  const flushOpt = () => { if (cur && opt) cur.options[opt] = buf.trim(); buf = ''; opt = null }
  const flushQ = () => {
    flushOpt()
    if (cur && cur.question && Object.keys(cur.options).length >= 2) questions.push(cur)
    cur = null
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^(代\s*號|類\s*科|科\s*目|考試|頁次|等\s*別|全.*題|本試題|座號|※|注意|【|】)/.test(line)) continue
    if (/^第?\s*\d+\s*頁/.test(line)) continue
    if (/^\d+\s*頁/.test(line)) continue

    // Detect MC section
    if (/([一二三四乙貳]、|乙[、.])\s*(測驗|選擇|單選)/.test(line) || /測驗題|單一選擇題|選擇題/.test(line)) {
      if (!inMcSection) { cur = null; opt = null; buf = ''; inMcSection = true }
      continue
    }

    // New question
    const qm = line.match(/^(\d{1,2})[.、．]\s*(.*)$/)
    if (qm && (line.length > 6 || /[\u4e00-\u9fff a-zA-Z]/.test(qm[2] || '') || (qm[2] || '') === '')) {
      const num = parseInt(qm[1])
      const isFirst = !cur && questions.length === 0
      if (num >= 1 && num <= 200 && (isFirst || (cur && num === cur.number + 1))) {
        flushQ()
        cur = { number: num, question: (qm[2] || '').trim(), options: {} }
        continue
      }
    }

    // Option
    const om = line.match(/^[\(（]\s*([A-Da-dＡＢＣＤ])\s*[\)）]\s*(.*)$/)
      || line.match(/^([A-Da-dＡＢＣＤ])\s*[.．、]\s*(.*)$/)
    if (om && cur) {
      flushOpt()
      opt = om[1].toUpperCase().replace('Ａ', 'A').replace('Ｂ', 'B').replace('Ｃ', 'C').replace('Ｄ', 'D')
      buf = om[2] || ''
      continue
    }

    if (opt) buf += ' ' + line
    else if (cur) cur.question += ' ' + line
  }
  flushQ()
  return questions
}

// ─── Exam definitions for years 100-105 ───
// Each target: { examId, file, year, code, session, classCode, subjects }
// subjects: [{ s, subject, tag, name }]

// Expected PDF exam name per examId (for contamination validation)
const EXPECTED_EXAM_NAMES = {
  'doctor1': '醫師',
  'doctor2': '醫師',
  'dental1': '牙醫師',
  'dental2': '牙醫師',
  'pharma1': '藥師',
  'pharma2': '藥師',
  'medlab': '醫事檢驗師',
  'radiology': '醫事放射師',
  'pt': '物理治療師',
  'ot': '職能治療師',
  'nursing': '護理師',
  'nutrition': '營養師',
  'social-worker': '社會工作師',
  'tcm1': '中醫師',
  'tcm2': '中醫師',
  'vet': '獸醫師',
}

function buildTargets(filterExam, filterYear) {
  const targets = []

  function add(examId, file, year, code, session, classCode, subjects) {
    if (filterExam && filterExam !== examId) return
    if (filterYear && filterYear !== year) return
    targets.push({ examId, file, year, code, session, classCode, subjects,
                   expectedExamName: EXPECTED_EXAM_NAMES[examId] || null })
  }

  // ─── 030 series (4-digit s codes) ───

  // Doctor1 — c=101 in year 100-101
  const doctor1Subs = [
    { s: '0101', subject: '醫學(一)', tag: 'anatomy', name: '醫學(一)' },
    { s: '0102', subject: '醫學(二)', tag: 'pathology', name: '醫學(二)' },
  ]
  add('doctor1', 'questions.json', '100', '100030', '第一次', '101', doctor1Subs)
  add('doctor1', 'questions.json', '101', '101030', '第一次', '101', doctor1Subs)
  add('doctor1', 'questions.json', '102', '102030', '第一次', '101', doctor1Subs)
  add('doctor1', 'questions.json', '103', '103030', '第一次', '101', doctor1Subs)
  add('doctor1', 'questions.json', '103', '103100', '第二次', '101', doctor1Subs)
  add('doctor1', 'questions.json', '104', '104030', '第一次', '101', doctor1Subs)
  // 100140 第二次: c=101, s=0101,0102 (same as 030)
  add('doctor1', 'questions.json', '100', '100140', '第二次', '101', doctor1Subs)
  // 102110 第二次 030系列: c=101, s=0101,0102 (user-provided URL confirmed)
  add('doctor1', 'questions.json', '102', '102110', '第二次', '101', doctor1Subs)

  // Doctor2 — c=102 in 030 series years 100-104
  const doctor2Subs = [
    { s: '0103', subject: '醫學(三)', tag: 'internal_medicine', name: '醫學(三)' },
    { s: '0104', subject: '醫學(四)', tag: 'pediatrics', name: '醫學(四)' },
    { s: '0105', subject: '醫學(五)', tag: 'surgery', name: '醫學(五)' },
    { s: '0106', subject: '醫學(六)', tag: 'medical_law_ethics', name: '醫學(六)' },
  ]
  add('doctor2', 'questions-doctor2.json', '100', '100030', '第一次', '102', doctor2Subs)
  add('doctor2', 'questions-doctor2.json', '101', '101030', '第一次', '102', doctor2Subs)
  add('doctor2', 'questions-doctor2.json', '102', '102030', '第一次', '102', doctor2Subs)
  add('doctor2', 'questions-doctor2.json', '103', '103030', '第一次', '102', doctor2Subs)
  add('doctor2', 'questions-doctor2.json', '103', '103100', '第二次', '102', doctor2Subs)
  add('doctor2', 'questions-doctor2.json', '104', '104030', '第一次', '102', doctor2Subs)
  // 100140 第二次: c=102, s=0103-0106 (same as 030)
  add('doctor2', 'questions-doctor2.json', '100', '100140', '第二次', '102', doctor2Subs)

  // Pharma — c=103 in years 100-101 (combined pharma1+pharma2)
  // pharma1 subjects: 藥理學, 藥物分析, 藥劑學
  const pharma1SubsOld = [
    { s: '0201', subject: '卷一', tag: 'pharmacology', name: '藥理學與藥物化學' },
    { s: '0202', subject: '卷二', tag: 'pharmaceutical_analysis', name: '藥物分析與生藥學' },
    { s: '0204', subject: '卷三', tag: 'pharmaceutics', name: '藥劑學（包括生物藥劑學）' },
  ]
  // pharma2 subjects: 調劑, 藥物治療, 法規
  const pharma2SubsOld = [
    { s: '0203', subject: '調劑與臨床', tag: 'dispensing', name: '調劑學與臨床藥學' },
    { s: '0205', subject: '藥物治療', tag: 'pharmacotherapy', name: '藥物治療學' },
    { s: '0206', subject: '法規', tag: 'pharmacy_law', name: '藥事行政與法規' },
  ]
  add('pharma1', 'questions-pharma1.json', '100', '100030', '第一次', '103', pharma1SubsOld)
  add('pharma1', 'questions-pharma1.json', '101', '101030', '第一次', '103', pharma1SubsOld)
  add('pharma2', 'questions-pharma2.json', '100', '100030', '第一次', '103', pharma2SubsOld)
  add('pharma2', 'questions-pharma2.json', '101', '101030', '第一次', '103', pharma2SubsOld)
  // 100140 第二次: c=103, same s-codes split as 030 series
  add('pharma1', 'questions-pharma1.json', '100', '100140', '第二次', '103', pharma1SubsOld)
  add('pharma2', 'questions-pharma2.json', '100', '100140', '第二次', '103', pharma2SubsOld)

  // Medlab — c=104 in years 100-101 (030 series)
  const medlabSubs030 = [
    { s: '0107', subject: '臨床生理學與病理學', tag: 'clinical_physio_path', name: '臨床生理學與病理學' },
    { s: '0301', subject: '臨床血液學與血庫學', tag: 'hematology', name: '臨床血液學與血庫學' },
    { s: '0302', subject: '醫學分子檢驗學與臨床鏡檢學', tag: 'molecular', name: '臨床鏡檢學（包括寄生蟲學）' },
    { s: '0303', subject: '微生物學與臨床微生物學', tag: 'microbiology', name: '微生物學及臨床微生物學' },
    { s: '0304', subject: '生物化學與臨床生化學', tag: 'biochemistry', name: '生物化學與臨床生化學' },
    { s: '0305', subject: '臨床血清免疫學與臨床病毒學', tag: 'serology', name: '臨床血清免疫學與臨床病毒學' },
  ]
  add('medlab', 'questions-medlab.json', '100', '100030', '第一次', '104', medlabSubs030)
  add('medlab', 'questions-medlab.json', '101', '101030', '第一次', '104', medlabSubs030)
  // 100140 第二次: c=104, s=0107,0301-0305 (same as 030)
  add('medlab', 'questions-medlab.json', '100', '100140', '第二次', '104', medlabSubs030)

  // PT — c=106 in year 100 (030 series)
  const ptSubs030 = [
    { s: '0501', subject: '物理治療基礎學', tag: 'pt_basic', name: '物理治療基礎學' },
    { s: '0502', subject: '物���治療學概論', tag: 'pt_intro', name: '物理治療學概論' },
    { s: '0503', subject: '物理治療技術學', tag: 'pt_technique', name: '物理治療技術學' },
    { s: '0504', subject: '神經疾病物理治療學', tag: 'pt_neuro', name: '神經疾病物理治療學' },
    { s: '0505', subject: '骨科疾病物理治療學', tag: 'pt_ortho', name: '骨科疾病物理治療學' },
    { s: '0506', subject: '心肺疾病��小兒疾病物理治療學', tag: 'pt_cardio_peds', name: '心肺疾病與小兒疾病物理治療學' },
  ]
  add('pt', 'questions-pt.json', '100', '100030', '第一次', '106', ptSubs030)

  // TCM — c=107 in year 100; c=106 in year 101; c=101 in years 104-105
  const tcm1SubsOld = [
    { s: '0601', subject: '中醫���礎醫學(一)', tag: 'tcm_basic_1', name: '中醫基礎醫學(一)' },
    { s: '0602', subject: '中醫基礎醫學(二)', tag: 'tcm_basic_2', name: '中醫基礎醫學(二)' },
  ]
  const tcm2SubsOld = [
    { s: '0603', subject: '中��臨床醫學(一)', tag: 'tcm_clinical_1', name: '中醫臨床醫學(一)' },
    { s: '0604', subject: '中醫臨床醫學(二)', tag: 'tcm_clinical_2', name: '中醫臨床醫學(二)' },
    { s: '0605', subject: '中醫臨床醫學(三)', tag: 'tcm_clinical_3', name: '中醫臨床醫學(三)' },
    { s: '0606', subject: '中醫臨床醫學(四)', tag: 'tcm_clinical_4', name: '中醫臨床醫學(四)' },
  ]
  // Year 100: c=107
  add('tcm1', 'questions-tcm1.json', '100', '100030', '第一次', '107', tcm1SubsOld)
  add('tcm2', 'questions-tcm2.json', '100', '100030', '第一次', '107', tcm2SubsOld)
  // Year 101: c=106, subjects shift to 0501/0502 and 0503-0506
  const tcm1Subs101 = [
    { s: '0501', subject: '中醫基礎醫學(一)', tag: 'tcm_basic_1', name: '中醫基礎醫學(一)' },
    { s: '0502', subject: '中醫基礎醫學(二)', tag: 'tcm_basic_2', name: '中醫基礎醫學(二)' },
  ]
  const tcm2Subs101 = [
    { s: '0503', subject: '中醫臨床醫學(一)', tag: 'tcm_clinical_1', name: '中醫臨床醫學(一)' },
    { s: '0504', subject: '中醫臨床醫學(二)', tag: 'tcm_clinical_2', name: '中醫臨床醫學(二)' },
    { s: '0505', subject: '中醫臨床醫學(三)', tag: 'tcm_clinical_3', name: '中醫臨床醫學(三)' },
    { s: '0506', subject: '中醫臨床醫學(四)', tag: 'tcm_clinical_4', name: '中醫臨床醫學(四)' },
  ]
  add('tcm1', 'questions-tcm1.json', '101', '101030', '第一次', '106', tcm1Subs101)
  add('tcm2', 'questions-tcm2.json', '101', '101030', '第一次', '106', tcm2Subs101)
  // 100140 第二次: c=106 (both tcm1 and tcm2 share same class code, s codes same as 101030)
  add('tcm1', 'questions-tcm1.json', '100', '100140', '第二次', '106', tcm1Subs101)
  add('tcm2', 'questions-tcm2.json', '100', '100140', '第二次', '106', tcm2Subs101)
  // Years 102-103: c=109 for tcm1, c=110 for tcm2 (yr103 tcm2 splits across two class codes)
  add('tcm1', 'questions-tcm1.json', '102', '102030', '第一次', '109', tcm1Subs101)
  add('tcm1', 'questions-tcm1.json', '103', '103030', '第一次', '109', tcm1Subs101)
  const tcm2Subs102 = [
    { s: '0601', subject: '中醫臨床醫學(一)', tag: 'tcm_clinical_1', name: '中醫臨床醫學(一)' },
    { s: '0602', subject: '中醫臨床醫學(二)', tag: 'tcm_clinical_2', name: '中醫臨床醫學(二)' },
    { s: '0603', subject: '中醫臨床醫學(三)', tag: 'tcm_clinical_3', name: '中醫臨床醫學(三)' },
    { s: '0604', subject: '中醫臨床醫學(四)', tag: 'tcm_clinical_4', name: '中醫臨床醫學(四)' },
  ]
  add('tcm2', 'questions-tcm2.json', '102', '102030', '第一次', '110', tcm2Subs102)
  // 102110 第二次: c=105 tcm2 (s=0203-0206)
  add('tcm2', 'questions-tcm2.json', '102', '102110', '第二次', '105', [
    { s: '0203', subject: '中醫臨床醫學(一)', tag: 'tcm_clinical_1', name: '中醫臨床醫學(一)' },
    { s: '0204', subject: '中醫臨床醫學(二)', tag: 'tcm_clinical_2', name: '中醫臨床醫學(二)' },
    { s: '0205', subject: '中醫臨床醫學(三)', tag: 'tcm_clinical_3', name: '中醫臨床醫學(三)' },
    { s: '0206', subject: '中醫臨床醫學(四)', tag: 'tcm_clinical_4', name: '中醫臨床醫學(四)' },
  ])
  // TCM2 yr103 — split: c=110 has subjects 0601-0603, c=109 has 0503-0504
  add('tcm2', 'questions-tcm2.json', '103', '103030', '第一次', '110', [
    { s: '0601', subject: '中醫臨床醫學(一)', tag: 'tcm_clinical_1', name: '中醫臨床醫學(一)' },
    { s: '0602', subject: '中醫臨床醫學(二)', tag: 'tcm_clinical_2', name: '中醫臨床醫學(二)' },
    { s: '0603', subject: '中醫臨床醫學(三)', tag: 'tcm_clinical_3', name: '中醫臨床醫學(三)' },
  ])
  add('tcm2', 'questions-tcm2.json', '103', '103030', '第一次', '109', [
    { s: '0503', subject: '中醫臨床醫學(三)', tag: 'tcm_clinical_3', name: '中醫臨床醫學(三)' },
    { s: '0504', subject: '中醫臨床醫學(四)', tag: 'tcm_clinical_4', name: '中醫臨床醫學(四)' },
  ])
  // tcm2 100-2: code=100090 c=101 returns "(not found)" — PDF on MoEX but no exam name, skipped by validator
  // TCM 103-2: code=103100; tcm1 uses c=103 (s=0201,0202), tcm2 uses c=104 (s=0203-0206)
  add('tcm1', 'questions-tcm1.json', '103', '103100', '第二次', '103', [
    { s: '0201', subject: '中醫基礎醫學(一)', tag: 'tcm_basic_1', name: '中醫基礎醫學(一)' },
    { s: '0202', subject: '中醫基礎醫學(二)', tag: 'tcm_basic_2', name: '中醫基礎醫學(二)' },
  ])
  add('tcm2', 'questions-tcm2.json', '103', '103100', '第二次', '104', [
    { s: '0203', subject: '中醫臨床醫學(一)', tag: 'tcm_clinical_1', name: '中醫臨床醫學(一)' },
    { s: '0204', subject: '中醫臨床醫學(二)', tag: 'tcm_clinical_2', name: '中醫臨床醫學(二)' },
    { s: '0205', subject: '中醫臨床醫學(三)', tag: 'tcm_clinical_3', name: '中醫臨床醫學(三)' },
    { s: '0206', subject: '中醫臨床醫學(四)', tag: 'tcm_clinical_4', name: '中醫臨床醫學(四)' },
  ])

  // Years 104-105: c=101 for tcm1, c=102 for tcm2
  const tcm1Subs104 = [
    { s: '0101', subject: '中醫基礎醫學(一)', tag: 'tcm_basic_1', name: '中醫基礎醫學(一)' },
    { s: '0102', subject: '中醫基礎醫學(二)', tag: 'tcm_basic_2', name: '中醫基礎醫學(二)' },
  ]
  const tcm2Subs104 = [
    { s: '0103', subject: '中醫臨床醫學(一)', tag: 'tcm_clinical_1', name: '中醫臨床醫學(一)' },
    { s: '0104', subject: '中醫臨床醫學(二)', tag: 'tcm_clinical_2', name: '中醫臨床醫學(二)' },
    { s: '0105', subject: '中醫臨床醫學(三)', tag: 'tcm_clinical_3', name: '中醫臨床醫學(三)' },
    { s: '0106', subject: '中醫臨床醫學(四)', tag: 'tcm_clinical_4', name: '中醫臨床醫學(四)' },
  ]
  // 104030 第一次: c=103=tcm1, c=104=tcm2 (different from 104100 system; s codes differ from tcm1Subs101)
  add('tcm1', 'questions-tcm1.json', '104', '104030', '第一次', '103', [
    { s: '0201', subject: '中醫基礎醫學(一)', tag: 'tcm_basic_1', name: '中醫基礎醫學(一)' },
    { s: '0202', subject: '中醫基礎醫學(二)', tag: 'tcm_basic_2', name: '中醫基礎醫學(二)' },
  ])
  add('tcm2', 'questions-tcm2.json', '104', '104030', '第一次', '104', [
    { s: '0203', subject: '中醫臨床醫學(一)', tag: 'tcm_clinical_1', name: '中醫臨床醫學(一)' },
    { s: '0204', subject: '中醫臨床醫學(二)', tag: 'tcm_clinical_2', name: '中醫臨床醫學(二)' },
    { s: '0205', subject: '中醫臨床醫學(三)', tag: 'tcm_clinical_3', name: '中醫臨床醫學(三)' },
    { s: '0206', subject: '中醫臨床醫學(四)', tag: 'tcm_clinical_4', name: '中醫臨床醫學(四)' },
  ])
  add('tcm1', 'questions-tcm1.json', '104', '104100', '第二次', '101', tcm1Subs104)
  add('tcm2', 'questions-tcm2.json', '104', '104100', '第二次', '102', tcm2Subs104)
  add('tcm1', 'questions-tcm1.json', '105', '105030', '第一次', '101', tcm1Subs104)
  add('tcm2', 'questions-tcm2.json', '105', '105030', '第一次', '102', tcm2Subs104)
  add('tcm1', 'questions-tcm1.json', '105', '105090', '第二次', '101', tcm1Subs104)
  add('tcm2', 'questions-tcm2.json', '105', '105090', '第二次', '102', tcm2Subs104)

  // Nursing — c=105 in year 101; c=106 in years 104-105
  const nursingSubs101 = [
    { s: '0108', subject: '基礎醫學', tag: 'basic_medicine', name: '基礎醫學' },
    { s: '0401', subject: '基本護理學與護理行政', tag: 'basic_nursing', name: '基本護理學與護理行政' },
    { s: '0402', subject: '內外科護理學', tag: 'med_surg', name: '內外科護理學' },
    { s: '0403', subject: '產兒科護理學', tag: 'obs_ped', name: '產兒科護理學' },
    { s: '0404', subject: '精神科與社區衛生護理學', tag: 'psych_community', name: '精神科與社區衛生護理學' },
  ]
  add('nursing', 'questions-nursing.json', '100', '100030', '第一次', '105', nursingSubs101)
  add('nursing', 'questions-nursing.json', '100', '100140', '第二次', '105', nursingSubs101)
  add('nursing', 'questions-nursing.json', '101', '101030', '第一次', '105', nursingSubs101)
  // Nursing yr102-103 — c=107, only 4 subjects found (missing 基礎醫學 s=0108)
  const nursingSubs102 = [
    { s: '0401', subject: '基本護理學與護理行政', tag: 'basic_nursing', name: '基本護理學與護理行政' },
    { s: '0402', subject: '內外科護理學', tag: 'med_surg', name: '內外科護理學' },
    { s: '0403', subject: '產兒科護理學', tag: 'obs_ped', name: '產兒科護理學' },
    { s: '0404', subject: '精神科與社區衛生護理學', tag: 'psych_community', name: '精神科與社區衛生護理學' },
  ]
  add('nursing', 'questions-nursing.json', '102', '102030', '第一次', '107', nursingSubs102)
  add('nursing', 'questions-nursing.json', '103', '103030', '第一次', '107', nursingSubs102)
  add('nursing', 'questions-nursing.json', '103', '103100', '第二次', '107', nursingSubs102)
  const nursingSubs104 = [
    { s: '0501', subject: '基礎醫學', tag: 'basic_medicine', name: '基礎醫學' },
    { s: '0502', subject: '基本護理學與護理行政', tag: 'basic_nursing', name: '基本護理學與護理行政' },
    { s: '0503', subject: '內外科護理學', tag: 'med_surg', name: '內外科護理學' },
    { s: '0504', subject: '產兒科護理學', tag: 'obs_ped', name: '產兒科護理學' },
    { s: '0505', subject: '精神科與社區衛生護理學', tag: 'psych_community', name: '精神科與社區衛生護理學' },
  ]
  // 104030 第一次: c=109, 4 subjects (no 基礎醫學), s=0501-0504 ≠ nursingSubs104's s=0501
  const nursingSubs104030 = [
    { s: '0501', subject: '基本護理學與護理行政', tag: 'basic_nursing', name: '基本護理學與護理行政' },
    { s: '0502', subject: '內外科護理學', tag: 'med_surg', name: '內外科護理學' },
    { s: '0503', subject: '產兒科護理學', tag: 'obs_ped', name: '產兒科護理學' },
    { s: '0504', subject: '精神科與社區衛生護理學', tag: 'psych_community', name: '精神科與社區衛生護理學' },
  ]
  add('nursing', 'questions-nursing.json', '104', '104030', '第一次', '109', nursingSubs104030)
  add('nursing', 'questions-nursing.json', '104', '104100', '第二次', '106', nursingSubs104)
  add('nursing', 'questions-nursing.json', '105', '105030', '第一次', '106', nursingSubs104)
  add('nursing', 'questions-nursing.json', '105', '105090', '第二次', '106', nursingSubs104)

  // Nutrition — c=107 in year 101; c=103 in years 104-105
  // Year 100: c=107 = TCM (中醫師), NOT nutrition — no nutrition exam in 030 series yr100
  // Years 102-103: c=103 = TCM, NOT nutrition — correct class code unknown; years skipped
  const nutritionSubs = [
    { s: '0601', subject: '生理學與生物化學', tag: 'physio_biochem', name: '生理學與生物化學' },
    { s: '0602', subject: '營養學', tag: 'nutrition_science', name: '營養學' },
    { s: '0603', subject: '膳食療養學', tag: 'diet_therapy', name: '膳食療養學' },
    { s: '0604', subject: '團體膳食設計與管理', tag: 'group_meal', name: '團體膳食設計與管理' },
    { s: '0605', subject: '公共衛生營養學', tag: 'public_nutrition', name: '公共衛生營養學' },
    { s: '0606', subject: '食品衛生與安全', tag: 'food_safety', name: '食品衛生與安全' },
  ]
  add('nutrition', 'questions-nutrition.json', '101', '101030', '第一次', '107', nutritionSubs)
  // 100140 第二次: c=107, s=0601-0606 (same as nutritionSubs)
  add('nutrition', 'questions-nutrition.json', '100', '100140', '第二次', '107', nutritionSubs)
  const nutritionSubs104 = nutritionSubs.map((sub, i) => ({
    ...sub, s: `020${i + 1}`  // 0201-0206
  }))
  // 104030 第一次: c=106, s=0301-0306
  const nutritionSubs104030 = nutritionSubs.map((sub, i) => ({
    ...sub, s: `030${i + 1}`  // 0301-0306
  }))
  add('nutrition', 'questions-nutrition.json', '104', '104030', '第一次', '106', nutritionSubs104030)
  add('nutrition', 'questions-nutrition.json', '104', '104100', '第二次', '103', nutritionSubs104)
  add('nutrition', 'questions-nutrition.json', '105', '105030', '第一次', '103', nutritionSubs104)
  add('nutrition', 'questions-nutrition.json', '105', '105090', '第二次', '103', nutritionSubs104)

  // Social Worker — c=107 in years 104-105
  const swSubs = [
    { s: '0601', subject: '社會工作', tag: 'social_work', name: '社會工作' },
    { s: '0602', subject: '社會工作直接服務', tag: 'social_work_direct', name: '社會工作直接服務' },
    { s: '0603', subject: '社會工作管理', tag: 'social_work_mgmt', name: '社會工作管理' },
  ]
  // Note: 104100 c=107 has subjects 0601-0606, but SW only has 3 subjects
  // The other 3 (0604-0606) might be different exam sharing class code
  // 104030 第一次: c=110 (not c=107 which is 臨床心理師 at 104030)
  add('social-worker', 'questions-social-worker.json', '104', '104030', '第一次', '110', swSubs)
  add('social-worker', 'questions-social-worker.json', '104', '104100', '第二次', '107', swSubs)
  add('social-worker', 'questions-social-worker.json', '105', '105030', '第一次', '107', swSubs)
  add('social-worker', 'questions-social-worker.json', '105', '105090', '第二次', '107', swSubs)

  // ─── 020 series (2-digit s codes) ───

  // Dental1 — c=301 years 100-104, c=303 year 105 (class code rotated in 105)
  const dental1Subs = [
    { s: '11', subject: '卷一', tag: 'dental_anatomy', name: '牙醫學(一)' },
    { s: '22', subject: '卷二', tag: 'oral_pathology', name: '牙醫學(二)' },
  ]
  add('dental1', 'questions-dental1.json', '100', '100020', '第一次', '301', dental1Subs)
  // 100130 第二次: c=301, s=11,22
  add('dental1', 'questions-dental1.json', '100', '100130', '第二次', '301', dental1Subs)
  add('dental1', 'questions-dental1.json', '101', '101010', '第一次', '301', dental1Subs)
  add('dental1', 'questions-dental1.json', '101', '101100', '第二次', '301', dental1Subs)
  add('dental1', 'questions-dental1.json', '102', '102020', '第一次', '301', dental1Subs)
  add('dental1', 'questions-dental1.json', '102', '102100', '第二次', '301', dental1Subs)
  add('dental1', 'questions-dental1.json', '103', '103020', '第一次', '301', dental1Subs)
  add('dental1', 'questions-dental1.json', '103', '103090', '第二次', '301', dental1Subs)
  // dental1 100-2: code=100100 c=301 returns "一等船副" (maritime exam), not dental — truly missing
  add('dental1', 'questions-dental1.json', '104', '104020', '第一次', '301', dental1Subs)
  add('dental1', 'questions-dental1.json', '104', '104090', '第二次', '303', dental1Subs)
  add('dental1', 'questions-dental1.json', '105', '105020', '第一次', '303', dental1Subs)
  add('dental1', 'questions-dental1.json', '105', '105100', '第二次', '303', dental1Subs)

  // Dental2 — c=302 in years 100-103, c=304 in years 104-105
  const dental2Subs = [
    { s: '33', subject: '卷一', tag: 'dental_clinical_1', name: '牙醫學(三)' },
    { s: '44', subject: '卷二', tag: 'dental_clinical_2', name: '牙醫學(四)' },
    { s: '55', subject: '卷三', tag: 'dental_clinical_3', name: '牙醫學(五)' },
  ]
  // dental2 101-1: 101010 c=302, 4 subjects (s=33-66) — year 101 had 4 exam papers
  const dental2Subs101 = [
    { s: '33', subject: '卷一', tag: 'dental_clinical_1', name: '牙醫學(三)' },
    { s: '44', subject: '卷二', tag: 'dental_clinical_2', name: '牙醫學(四)' },
    { s: '55', subject: '卷三', tag: 'dental_clinical_3', name: '牙醫學(五)' },
    { s: '66', subject: '卷四', tag: 'dental_clinical_4', name: '牙醫學(六)' },
  ]
  add('dental2', 'questions-dental2.json', '100', '100020', '第一次', '302', dental2Subs)
  // 100130 第二次: c=302, s=33,44,55,66 (4 papers — same as dental2Subs101)
  add('dental2', 'questions-dental2.json', '100', '100130', '第二次', '302', dental2Subs101)
  // dental2 100-2 (100100): code=100100 c=302 returns "一等管輪" (maritime) — 100130 is the real 第二次
  add('dental2', 'questions-dental2.json', '101', '101010', '第一次', '302', dental2Subs101)
  add('dental2', 'questions-dental2.json', '101', '101100', '第二次', '302', dental2Subs)
  add('dental2', 'questions-dental2.json', '102', '102020', '第一次', '302', dental2Subs)
  add('dental2', 'questions-dental2.json', '102', '102100', '第二次', '302', dental2Subs)
  add('dental2', 'questions-dental2.json', '103', '103020', '第一次', '302', dental2Subs)
  add('dental2', 'questions-dental2.json', '103', '103090', '第二次', '302', dental2Subs)
  // yr104-1: only s=33 found under c=302
  add('dental2', 'questions-dental2.json', '104', '104020', '第一次', '302', [
    { s: '33', subject: '卷一', tag: 'dental_clinical_1', name: '牙醫學(三)' },
  ])
  // yr104-2: c=304, s=44,55
  add('dental2', 'questions-dental2.json', '104', '104090', '第二次', '304', [
    { s: '44', subject: '卷二', tag: 'dental_clinical_2', name: '牙醫學(四)' },
    { s: '55', subject: '卷三', tag: 'dental_clinical_3', name: '牙醫學(五)' },
  ])
  // yr105: c=304, only s=33
  add('dental2', 'questions-dental2.json', '105', '105020', '第一次', '304', [
    { s: '33', subject: '卷一', tag: 'dental_clinical_1', name: '牙醫學(三)' },
  ])
  add('dental2', 'questions-dental2.json', '105', '105100', '第二次', '304', [
    { s: '33', subject: '卷一', tag: 'dental_clinical_1', name: '牙醫學(三)' },
  ])

  // Doctor1 — c=301 in 020 series, year 104 second session only
  // s=55=醫學(一), s=66=醫學(二); s=33/44 return 302 (not available)
  const doctor1Subs020 = [
    { s: '55', subject: '醫學(一)', tag: 'anatomy', name: '醫學(一)' },
    { s: '66', subject: '醫學(二)', tag: 'pathology', name: '醫學(二)' },
  ]
  add('doctor1', 'questions.json', '104', '104090', '第二次', '301', doctor1Subs020)
  // 105100 第二次 020系列: c=301, s=55,66 — CBT 年但 PDF 仍可下載
  add('doctor1', 'questions.json', '105', '105100', '第二次', '301', doctor1Subs020)
  // 105020 / 106020 第一次 c=301 s=55,66 — 補齊 醫學(一)/醫學(二)
  add('doctor1', 'questions.json', '105', '105020', '第一次', '301', doctor1Subs020)
  add('doctor1', 'questions.json', '106', '106020', '第一次', '301', doctor1Subs020)

  // Doctor2 — c=302 in 020 series, years 104-105
  const doctor2Subs020 = [
    { s: '11', subject: '醫學(三)', tag: 'internal_medicine', name: '醫學(三)' },
    { s: '22', subject: '醫學(四)', tag: 'pediatrics', name: '醫學(四)' },
    { s: '33', subject: '醫學(五)', tag: 'surgery', name: '醫學(五)' },
    { s: '44', subject: '醫學(六)', tag: 'medical_law_ethics', name: '醫學(六)' },
  ]
  add('doctor2', 'questions-doctor2.json', '104', '104090', '第二次', '302', doctor2Subs020)
  add('doctor2', 'questions-doctor2.json', '105', '105020', '第一次', '302', doctor2Subs020)
  add('doctor2', 'questions-doctor2.json', '105', '105100', '第二次', '302', doctor2Subs020)

  // OT — c=305 years 100-104, c=312 year 105 (swapped with pharma1)
  const otSubs020 = [
    { s: '11', subject: '解剖學與生理學', tag: 'ot_anatomy', name: '解剖學與生理學' },
    { s: '22', subject: '職能治療學概論', tag: 'ot_intro', name: '職能治療學概論' },
    { s: '33', subject: '生理疾病職能治療學', tag: 'ot_physical', name: '生理疾病職能治療學' },
    { s: '44', subject: '心理疾病職能治療學', tag: 'ot_mental', name: '心理疾病職能治療學' },
    { s: '55', subject: '小兒疾病職能治療學', tag: 'ot_pediatric', name: '小兒疾病職能治療學' },
    { s: '66', subject: '職能治療技術學', tag: 'ot_technique', name: '職能治療技術學' },
  ]
  add('ot', 'questions-ot.json', '101', '101010', '第一次', '305', otSubs020)
  add('ot', 'questions-ot.json', '101', '101100', '第二次', '305', otSubs020)
  add('ot', 'questions-ot.json', '102', '102020', '第一次', '305', otSubs020)
  add('ot', 'questions-ot.json', '102', '102100', '第二次', '305', otSubs020)
  add('ot', 'questions-ot.json', '103', '103020', '第一次', '305', otSubs020)
  add('ot', 'questions-ot.json', '103', '103090', '第二次', '305', otSubs020)
  add('ot', 'questions-ot.json', '100', '100020', '第一次', '305', otSubs020)
  // 100130 第二次: c=305, s=11-66 (same as 020)
  add('ot', 'questions-ot.json', '100', '100130', '第二次', '305', otSubs020)
  add('ot', 'questions-ot.json', '104', '104020', '第一次', '305', otSubs020)
  add('ot', 'questions-ot.json', '104', '104090', '第二次', '312', otSubs020)
  // OT yr105 — c=312 (swapped from pharma1)
  add('ot', 'questions-ot.json', '105', '105020', '第一次', '312', otSubs020)
  add('ot', 'questions-ot.json', '105', '105100', '第二次', '312', otSubs020)

  // Radiology — c=308, years 100-105
  const radioSubs020 = [
    { s: '11', subject: '基礎醫學���包括解剖學、生理學與病理學）', tag: 'basic_medicine', name: '基礎醫學（包括解剖學、生理學與病理學）' },
    { s: '22', subject: '醫學物理學與輻射安全', tag: 'med_physics', name: '醫學物理學與輻射安全' },
    { s: '33', subject: '放射線器材學（包括磁振學與超音波學）', tag: 'radio_instruments', name: '放射線器材學（包括磁振學與超音波學）' },
    { s: '44', subject: '放射線診斷原理與技術學', tag: 'radio_diagnosis', name: '放射線診斷原理與技術學' },
    { s: '55', subject: '放射線治療原理與技術學', tag: 'radio_therapy', name: '放射線治療原理與技術學' },
    { s: '66', subject: '核子醫學診療原理與技術學', tag: 'nuclear_medicine', name: '核子醫學診療原理與技術學' },
  ]
  add('radiology', 'questions-radiology.json', '100', '100020', '第一次', '308', radioSubs020)
  // 100130 第二次: c=308, s=11-66 (same as 020)
  add('radiology', 'questions-radiology.json', '100', '100130', '第二次', '308', radioSubs020)
  add('radiology', 'questions-radiology.json', '101', '101010', '第一次', '308', radioSubs020)
  add('radiology', 'questions-radiology.json', '101', '101100', '第二次', '308', radioSubs020)
  add('radiology', 'questions-radiology.json', '102', '102020', '第一次', '308', radioSubs020)
  add('radiology', 'questions-radiology.json', '102', '102100', '第二次', '308', radioSubs020)
  add('radiology', 'questions-radiology.json', '103', '103020', '第一次', '308', radioSubs020)
  add('radiology', 'questions-radiology.json', '103', '103090', '第二次', '308', radioSubs020)
  add('radiology', 'questions-radiology.json', '104', '104020', '第一次', '308', radioSubs020)
  // 104090 (第二次): class code rotated to c=309 (same as 105+)
  add('radiology', 'questions-radiology.json', '104', '104090', '第二次', '309', radioSubs020)
  // 105年 class code rotated: radiology moved to c=309
  add('radiology', 'questions-radiology.json', '105', '105020', '第一次', '309', radioSubs020)
  add('radiology', 'questions-radiology.json', '105', '105100', '第二次', '309', radioSubs020)

  // PT — c=309 in 020 series (years 101-105)
  const ptSubs020 = [
    { s: '11', subject: '物理治療基礎學', tag: 'pt_basic', name: '物理治療基礎學' },
    { s: '22', subject: '物理治療學概論', tag: 'pt_intro', name: '物理治療學概論' },
    { s: '33', subject: '物理治療技術學', tag: 'pt_technique', name: '物理治療技術學' },
    { s: '44', subject: '神經疾病物理治療學', tag: 'pt_neuro', name: '神經疾病物理治療學' },
    { s: '55', subject: '骨科疾病物理治療學', tag: 'pt_ortho', name: '骨科疾病物理治療學' },
    { s: '66', subject: '心肺疾��與小兒疾病物理治療學', tag: 'pt_cardio_peds', name: '心肺疾病與小兒疾病物理治療學' },
  ]
  // 100130 第二次: c=309, s=11-66 (same subjects as 020 series 101+)
  add('pt', 'questions-pt.json', '100', '100130', '第二次', '309', ptSubs020)
  add('pt', 'questions-pt.json', '101', '101010', '第一次', '309', ptSubs020)
  add('pt', 'questions-pt.json', '101', '101100', '第二次', '309', ptSubs020)
  add('pt', 'questions-pt.json', '102', '102020', '第一次', '309', ptSubs020)
  add('pt', 'questions-pt.json', '102', '102100', '第二次', '309', ptSubs020)
  add('pt', 'questions-pt.json', '103', '103020', '第一次', '309', ptSubs020)
  add('pt', 'questions-pt.json', '103', '103090', '第二次', '309', ptSubs020)
  add('pt', 'questions-pt.json', '104', '104020', '第一次', '309', ptSubs020)
  // 104090 (第二次): class code rotated to c=311 (same as 105+)
  add('pt', 'questions-pt.json', '104', '104090', '第二次', '311', ptSubs020)
  // 105年 class code rotated: PT moved to c=311
  add('pt', 'questions-pt.json', '105', '105020', '第一次', '311', ptSubs020)
  add('pt', 'questions-pt.json', '105', '105100', '第二次', '311', ptSubs020)

  // Medlab — c=311 in 020 series (years 102-105)
  const medlabSubs020 = [
    { s: '11', subject: '臨床生理學與病理學', tag: 'clinical_physio_path', name: '臨床生理學與病理學' },
    { s: '22', subject: '臨床血液學與血庫學', tag: 'hematology', name: '臨床血液學與血庫學' },
    { s: '33', subject: '醫學分子檢驗學與臨床鏡檢學', tag: 'molecular', name: '醫學分子檢驗學與臨床鏡檢學' },
    { s: '44', subject: '微生物學與臨床微生物學', tag: 'microbiology', name: '微生物學與臨床微生物學' },
    { s: '55', subject: '生物化學與臨床生化學', tag: 'biochemistry', name: '生物化學與臨床生化學' },
    { s: '66', subject: '臨床血清免疫學與臨床病毒學', tag: 'serology', name: '臨床血清免疫學與臨床病毒學' },
  ]
  add('medlab', 'questions-medlab.json', '102', '102100', '第二次', '311', medlabSubs020)
  add('medlab', 'questions-medlab.json', '103', '103020', '第一次', '311', medlabSubs020)
  add('medlab', 'questions-medlab.json', '103', '103090', '第二次', '311', medlabSubs020)
  add('medlab', 'questions-medlab.json', '104', '104020', '第一次', '311', medlabSubs020)
  // 104090 (第二次): class code rotated to c=308 (same as 105+)
  add('medlab', 'questions-medlab.json', '104', '104090', '第二次', '308', medlabSubs020)
  // 105年 class code rotated: medlab moved to c=308
  add('medlab', 'questions-medlab.json', '105', '105020', '第一次', '308', medlabSubs020)
  add('medlab', 'questions-medlab.json', '105', '105100', '第二次', '308', medlabSubs020)

  // Pharma1 — c=312 in 020 series (years 103-104)
  const pharma1Subs020 = [
    { s: '11', subject: '卷一', tag: 'pharmacology', name: '藥理學與藥物化學' },
    { s: '22', subject: '卷二', tag: 'pharmaceutical_analysis', name: '藥物分析與生藥學' },
    { s: '33', subject: '卷三', tag: 'pharmaceutics', name: '藥劑學（包括生物藥劑學）' },
  ]
  add('pharma1', 'questions-pharma1.json', '103', '103090', '第二次', '312', pharma1Subs020)
  add('pharma1', 'questions-pharma1.json', '104', '104020', '第一次', '312', pharma1Subs020)

  // Pharma combined — c=310 in 020 series (years 102-104, pharma1+pharma2 share class code)
  // pharma1 subjects in c=310: s=11,22,44
  const pharma1Subs310 = [
    { s: '11', subject: '卷一', tag: 'pharmacology', name: '藥理學與藥物化學' },
    { s: '22', subject: '卷二', tag: 'pharmaceutical_analysis', name: '藥物分析與生藥學' },
    { s: '44', subject: '卷三', tag: 'pharmaceutics', name: '藥劑學（包括生物藥劑學）' },
  ]
  // pharma2 subjects in c=310: s=33,55,66
  const pharma2Subs310 = [
    { s: '33', subject: '調劑與臨床', tag: 'dispensing', name: '調劑學與臨床藥學' },
    { s: '55', subject: '藥物治療', tag: 'pharmacotherapy', name: '藥物治療學' },
    { s: '66', subject: '法規', tag: 'pharmacy_law', name: '藥事行政與法規' },
  ]
  add('pharma1', 'questions-pharma1.json', '102', '102020', '第一次', '310', pharma1Subs310)
  add('pharma1', 'questions-pharma1.json', '102', '102100', '第二次', '310', pharma1Subs310)
  add('pharma1', 'questions-pharma1.json', '103', '103020', '第一次', '310', pharma1Subs310)
  add('pharma1', 'questions-pharma1.json', '103', '103090', '第二次', '310', pharma1Subs310)
  add('pharma1', 'questions-pharma1.json', '104', '104020', '第一次', '310', pharma1Subs310)
  // 104090 (第二次): c=306 confirmed from MoEX URL, s=11,22,44
  add('pharma1', 'questions-pharma1.json', '104', '104090', '第二次', '306', pharma1Subs310)
  add('pharma2', 'questions-pharma2.json', '102', '102020', '第一次', '310', pharma2Subs310)
  add('pharma2', 'questions-pharma2.json', '102', '102100', '第二次', '310', pharma2Subs310)
  add('pharma2', 'questions-pharma2.json', '103', '103020', '第一次', '310', pharma2Subs310)
  add('pharma2', 'questions-pharma2.json', '103', '103090', '第二次', '310', pharma2Subs310)
  add('pharma2', 'questions-pharma2.json', '104', '104020', '第一次', '310', pharma2Subs310)
  // 104090 pharma2: c=306 (not c=310 which returns wrong content) confirmed s=44,55,66
  add('pharma2', 'questions-pharma2.json', '104', '104090', '第二次', '306', [
    { s: '44', subject: '調劑與臨床', tag: 'dispensing', name: '調劑學與臨床藥學' },
    { s: '55', subject: '藥物治療', tag: 'pharmacotherapy', name: '藥物治療學' },
    { s: '66', subject: '法規', tag: 'pharmacy_law', name: '藥事行政與法規' },
  ])

  // Pharma1 yr105 — c=305 (swapped from OT), s=11,22,33
  add('pharma1', 'questions-pharma1.json', '105', '105020', '第一次', '305', pharma1Subs020)
  add('pharma1', 'questions-pharma1.json', '105', '105100', '第二次', '305', pharma1Subs020)

  // Pharma2 yr105 — c=307 (c=310 was wrong, returned nursing/genetics content)
  // Subject codes shift: s=44 (調劑), s=55 (藥物治療), s=66 (法規)
  const pharma2Subs307 = [
    { s: '44', subject: '調劑與臨床', tag: 'dispensing', name: '調劑學與臨床藥學' },
    { s: '55', subject: '藥物治療', tag: 'pharmacotherapy', name: '藥物治療學' },
    { s: '66', subject: '法規', tag: 'pharmacy_law', name: '藥事行政與法規' },
  ]
  add('pharma2', 'questions-pharma2.json', '105', '105020', '第一次', '307', pharma2Subs307)
  add('pharma2', 'questions-pharma2.json', '105', '105100', '第二次', '307', pharma2Subs307)

  // Vet — c=307 in 100130 第二次 (only 100年 in the 100-105 range)
  const vetSubs020 = [
    { s: '11', subject: '獸醫病理學', tag: 'vet_pathology', name: '獸醫病理學' },
    { s: '22', subject: '獸醫藥理學', tag: 'vet_pharmacology', name: '獸醫藥理學' },
    { s: '33', subject: '獸醫實驗診斷學', tag: 'vet_lab_diagnosis', name: '獸醫實驗診斷學' },
    { s: '44', subject: '獸醫普通疾病學', tag: 'vet_common_disease', name: '獸醫普通疾病學' },
    { s: '55', subject: '獸醫傳染病學', tag: 'vet_infectious', name: '獸醫傳染病學' },
    { s: '66', subject: '獸醫公共衛生學', tag: 'vet_public_health', name: '獸醫公共衛生學' },
  ]
  add('vet', 'questions-vet.json', '100', '100130', '第二次', '307', vetSubs020)
  // Vet 101年 第二次 — c=307 in 101100
  add('vet', 'questions-vet.json', '101', '101100', '第二次', '307', vetSubs020)

  // Pharma 101年 第二次 — c=310 in 101100 (pharma1+pharma2 share class code)
  add('pharma1', 'questions-pharma1.json', '101', '101100', '第二次', '310', pharma1Subs310)
  add('pharma2', 'questions-pharma2.json', '101', '101100', '第二次', '310', pharma2Subs310)

  // ─── 101110 第二次 (030 series, NEW session code — 030 考試的第二次) ───
  // doctor1/doctor2/tcm1/tcm2/nutrition/medlab/nursing all share this session
  add('doctor1', 'questions.json', '101', '101110', '第二次', '101', doctor1Subs)
  add('doctor2', 'questions-doctor2.json', '101', '101110', '第二次', '102', doctor2Subs)
  // tcm: c=103 combined class code (s=0201-0202 tcm1, s=0203-0206 tcm2)
  add('tcm1', 'questions-tcm1.json', '101', '101110', '第二次', '103', [
    { s: '0201', subject: '中醫基礎醫學(一)', tag: 'tcm_basic_1', name: '中醫基礎醫學(一)' },
    { s: '0202', subject: '中醫基礎醫學(二)', tag: 'tcm_basic_2', name: '中醫基礎醫學(二)' },
  ])
  add('tcm2', 'questions-tcm2.json', '101', '101110', '第二次', '103', [
    { s: '0203', subject: '中醫臨床醫學(一)', tag: 'tcm_clinical_1', name: '中醫臨床醫學(一)' },
    { s: '0204', subject: '中醫臨床醫學(二)', tag: 'tcm_clinical_2', name: '中醫臨床醫學(二)' },
    { s: '0205', subject: '中醫臨床醫學(三)', tag: 'tcm_clinical_3', name: '中醫臨床醫學(三)' },
    { s: '0206', subject: '中醫臨床醫學(四)', tag: 'tcm_clinical_4', name: '中醫臨床醫學(四)' },
  ])
  // nutrition: c=105, s=0301-0306
  add('nutrition', 'questions-nutrition.json', '101', '101110', '第二次', '105', nutritionSubs104030)
  // medlab: c=108, s=0107 + 0501-0505
  add('medlab', 'questions-medlab.json', '101', '101110', '第二次', '108', [
    { s: '0107', subject: '臨床生理學與病理學', tag: 'clinical_physio_path', name: '臨床生理學與病理學' },
    { s: '0501', subject: '臨床血液學與血庫學', tag: 'hematology', name: '臨床血液學與血庫學' },
    { s: '0502', subject: '醫學分子檢驗學與臨床鏡檢學', tag: 'molecular', name: '臨床鏡檢學（包括寄生蟲學）' },
    { s: '0503', subject: '微生物學與臨床微生物學', tag: 'microbiology', name: '微生物學及臨床微生物學' },
    { s: '0504', subject: '生物化學與臨床生化學', tag: 'biochemistry', name: '生物化學與臨床生化學' },
    { s: '0505', subject: '臨床血清免疫學與臨床病毒學', tag: 'serology', name: '臨床血清免疫學與臨床病毒學' },
  ])
  // nursing: c=109, s=0108 (基礎醫學) + 0601-0604
  add('nursing', 'questions-nursing.json', '101', '101110', '第二次', '109', [
    { s: '0108', subject: '基礎醫學', tag: 'basic_medicine', name: '基礎醫學' },
    { s: '0601', subject: '基本護理學與護理行政', tag: 'basic_nursing', name: '基本護理學' },
    { s: '0602', subject: '內外科護理學', tag: 'med_surg', name: '內外科護理學' },
    { s: '0603', subject: '產兒科護理學', tag: 'obs_ped', name: '產兒科護理學' },
    { s: '0604', subject: '精神科與社區衛生護理學', tag: 'psych_community', name: '精神科與社區衛生護理學' },
  ])

  return targets
}

// ─── Main ───

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const examIdx = args.indexOf('--exam')
  const yearIdx = args.indexOf('--year')
  const filterExam = examIdx >= 0 ? args[examIdx + 1] : null
  const filterYear = yearIdx >= 0 ? args[yearIdx + 1] : null

  const targets = buildTargets(filterExam, filterYear)
  console.log(`Found ${targets.length} scraping targets`)

  const byFile = {}
  for (const t of targets) {
    if (!byFile[t.file]) byFile[t.file] = []
    byFile[t.file].push(t)
  }

  let totalNew = 0

  for (const [file, fileTargets] of Object.entries(byFile)) {
    const filePath = path.join(BACKEND, file)
    let data, questions

    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      questions = data.questions || (Array.isArray(data) ? data : [])
    } catch {
      data = { metadata: { exam: fileTargets[0].examId, scraped_at: new Date().toISOString() }, total: 0, questions: [] }
      questions = data.questions
    }

    let nextId = questions.reduce((max, q) => {
      const n = typeof q.id === 'number' ? q.id : parseInt(q.id) || 0
      return Math.max(max, n)
    }, 0) + 1

    // Check which year+code+subject_tag combos already exist
    // Note: class_code is intentionally excluded — same subject under two class codes
    // (e.g. tcm2 yr103 中醫臨床醫學(三) shared between c=110 and c=109) should be
    // treated as the same paper and skipped to avoid duplicates.
    const existingCodes = new Set()
    for (const q of questions) existingCodes.add(`${q.roc_year}_${q.exam_code}_${q.subject_tag}`)

    console.log(`\n═══ ${file} (existing: ${questions.length} Q, next ID: ${nextId}) ═══`)

    let fileNew = 0

    for (const t of fileTargets) {
      console.log(`\n--- ${t.year}年${t.session} (${t.code}, c=${t.classCode}) ---`)
      let sessionFetched = false

      for (const sub of t.subjects) {
        // Skip if already exists
        if (existingCodes.has(`${t.year}_${t.code}_${sub.tag}`)) {
          console.log(`  ⏭ ${sub.name}: already exists`)
          continue
        }

        if (dryRun) {
          console.log(`  Q: ${BASE}?t=Q&code=${t.code}&c=${t.classCode}&s=${sub.s}&q=1`)
          console.log(`  A: ${BASE}?t=S&code=${t.code}&c=${t.classCode}&s=${sub.s}&q=1`)
          continue
        }

        let qBuf
        let networkFetched = false
        try {
          console.log(`  📥 ${sub.name}...`)
          const { buf, fromCache } = await cachedPdf('Q', t.code, t.classCode, sub.s)
          qBuf = buf
          if (!fromCache) networkFetched = true
        } catch (e) {
          console.log(`  ✗ ${sub.name}: Q download failed: ${e.message}`)
          continue
        }

        // Validate exam name in PDF matches expected exam (CLAUDE.md rule)
        // Use 類科名稱 regex — the title page can contain all exam names in a scrambled
        // repetition pattern, so simple substring on raw text is unreliable.
        if (t.expectedExamName) {
          try {
            const rawText = (await pdfParse(qBuf)).text.slice(0, 1000).normalize('NFKC')
            // Normalize: collapse whitespace so "醫事檢驗 師" → "醫事檢驗師"
            const normalized = rawText.replace(/\s+/g, '')
            const m = rawText.match(/類科名稱[：:]\s*([^\n\r]+)/) ||
                      rawText.match(/類\s*科[：:]\s*([^\n\r]+)/)
            const foundName = m ? m[1].trim().normalize('NFKC') : ''
            if (!foundName.includes(t.expectedExamName)) {
              console.error(`  ✗ ${sub.name}: PDF exam name mismatch! Expected "${t.expectedExamName}" but got "${foundName || '(not found)'}". Skipping.`)
              continue
            }
          } catch (e) {
            console.log(`  ⚠ ${sub.name}: Could not validate exam name: ${e.message}`)
          }
        }

        let answers = {}
        let ansCount = 0
        for (const ansType of ['S', 'A']) {
          if (ansCount >= 20) break
          try {
            const { buf: aBuf, fromCache: aFromCache } = await cachedPdf(ansType, t.code, t.classCode, sub.s)
            if (!aFromCache) networkFetched = true
            const aText = (await pdfParse(aBuf)).text
            let best = parseAnswersPdf(aText)
            let bestLen = Object.keys(best).length
            if (bestLen < 20) {
              try {
                const col = await parseAnswersColumnAware(aBuf)
                const colLen = Object.keys(col).length
                if (colLen > bestLen) { best = col; bestLen = colLen }
              } catch {}
            }
            if (bestLen > ansCount) {
              answers = best
              ansCount = bestLen
              if (ansType === 'A') console.log(`    📎 Used t=A answer PDF`)
            }
          } catch { /* try next */ }
        }
        if (ansCount < 20) {
          console.log(`  ⚠ Few/no answers for ${sub.name}: ${ansCount} found`)
        }

        // Download corrections — also extract answers from corrections text as last resort
        const disputedNums = new Set()
        try {
          const { buf: mBuf, fromCache: mFromCache } = await cachedPdf('M', t.code, t.classCode, sub.s)
          if (!mFromCache) networkFetched = true
          const mText = (await pdfParse(mBuf)).text

          // If we still have no answers, try extracting from corrections PDF
          if (ansCount < 20) {
            const fromCorr = parseAnswersPdf(mText)
            const fromCorrLen = Object.keys(fromCorr).length
            if (fromCorrLen > ansCount) {
              answers = fromCorr
              ansCount = fromCorrLen
              console.log(`    📎 Extracted ${fromCorrLen} answers from corrections PDF`)
            }
          }

          const corrections = parseCorrectionsPdf(mText)
          for (const [num, ans] of Object.entries(corrections)) {
            if (ans === '*') disputedNums.add(parseInt(num))
            else answers[num] = ans
          }
          const corrLen = Object.keys(corrections).length
          if (corrLen > 0) {
            console.log(`    📝 ${corrLen} corrections`)
          }
        } catch { /* no corrections is normal */ }

        let parsedMap = {}
        let parseMethod = 'column'
        try {
          parsedMap = await parseColumnAware(qBuf)
        } catch (e) {
          console.log(`    ⚠ Column parser failed: ${e.message}, trying text-based...`)
          parseMethod = 'text'
        }

        if (Object.keys(parsedMap).length < 10) {
          try {
            const qText = (await pdfParse(qBuf)).text
            const textParsed = parseQuestions(qText)
            if (textParsed.length > Object.keys(parsedMap).length) {
              parsedMap = {}
              for (const q of textParsed) parsedMap[q.number] = q
              parseMethod = 'text'
            }
          } catch { /* text parser also failed, use whatever we have */ }
        }

        const parsedCount = Object.keys(parsedMap).length

        // Build output
        let added = 0
        for (const [numStr, q] of Object.entries(parsedMap)) {
          const num = parseInt(numStr)
          const ans = answers[num]
          if (!ans) continue

          const opts = q.options || {}
          const cleanOpts = {}
          for (const k of ['A', 'B', 'C', 'D']) cleanOpts[k] = stripPUA(opts[k] || '')

          questions.push({
            id: nextId++,
            roc_year: t.year,
            session: t.session,
            exam_code: t.code,
            class_code: t.classCode,
            subject: sub.subject,
            subject_tag: sub.tag,
            subject_name: sub.name,
            stage_id: 0,
            number: num,
            question: stripPUA(q.question || ''),
            options: cleanOpts,
            answer: ans,
            explanation: '',
            ...(disputedNums.has(num) ? { disputed: true } : {}),
          })
          added++
        }

        console.log(`  ✓ ${sub.name}: ${parsedCount} parsed (${parseMethod}), ${ansCount} answers, ${added} added`)
        fileNew += added
        if (networkFetched) { sessionFetched = true; await sleep(300) }
      }

      if (sessionFetched) await sleep(400)
    }

    if (fileNew > 0 && !dryRun) {
      if (data.questions) data.total = questions.length
      try {
        atomicWriteJson(filePath, data)
        console.log(`  💾 Saved ${file}: ${questions.length} total (+${fileNew} new)`)
      } catch (e) {
        console.error(`  ✗ Failed to save ${file}: ${e.message}`)
      }
    }

    totalNew += fileNew
  }

  console.log(`\n${dryRun ? '[DRY RUN] ' : ''}總計新增: ${totalNew} questions`)
}

main().catch(e => { console.error(e); process.exit(1) })
