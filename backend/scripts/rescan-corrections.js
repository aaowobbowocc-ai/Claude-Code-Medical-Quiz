#!/usr/bin/env node
/**
 * 重新掃描考選部更正答案 PDF 並套用到 questions*.json
 *
 * Flow per exam:
 *   1. 讀取 questions JSON
 *   2. 清除所有既有的 disputed/correction_note/original_answer（恢復原始答案）
 *   3. 對每個 (exam_code, subject) 下載 t=M PDF
 *   4. Parse 更正答案（送分 / 多答案）
 *   5. 套用 convention B: answer='送分' or 'A,D', disputed=true, correction_note='...'
 *
 * Usage:
 *   node scripts/rescan-corrections.js --exam doctor1
 *   node scripts/rescan-corrections.js --exam all
 *   node scripts/rescan-corrections.js --exam doctor1 --dry-run
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

const BASE_URL = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'

// ─── 考試定義 (統一新舊格式) ───
// oldS = 110-113 年用的 2 位 s 碼
// newS = 114+ 年用的 4 位 s 碼
const EXAMS = {
  doctor1: {
    file: 'questions.json',
    classCode: '301',
    subjects: [
      { name: '醫學(一)', oldS: '11', newS: '0101' },
      { name: '醫學(二)', oldS: '22', newS: '0102' },
    ],
  },
  doctor2: {
    file: 'questions-doctor2.json',
    classCode: '302',
    subjects: [
      { name: '醫學(三)', oldS: '11', newS: '0103' },
      { name: '醫學(四)', oldS: '22', newS: '0104' },
      { name: '醫學(五)', oldS: '33', newS: '0105' },
      { name: '醫學(六)', oldS: '44', newS: '0106' },
    ],
  },
  dental1: {
    file: 'questions-dental1.json',
    classCode: '303',
    subjects: [
      { name: '卷一', oldS: '11', newS: '0201' },
      { name: '卷二', oldS: '22', newS: '0202' },
    ],
  },
  dental2: {
    file: 'questions-dental2.json',
    classCode: '304',
    subjects: [
      { name: '卷一', oldS: '33', newS: '0203' },
      { name: '卷二', oldS: '44', newS: '0204' },
      { name: '卷三', oldS: '55', newS: '0205' },
      { name: '卷四', oldS: '66', newS: '0206' },
    ],
  },
  pharma1: {
    file: 'questions-pharma1.json',
    classCode: '305',
    subjects: [
      { name: '卷一', oldS: '33', newS: '0401' },
      { name: '卷二', oldS: '44', newS: '0402' },
      { name: '卷三', oldS: '55', newS: '0403' },
    ],
  },
  pharma2: {
    file: 'questions-pharma2.json',
    classCode: '306',
    subjects: [
      { name: '調劑與臨床', oldS: '44', newS: '0404' },
      { name: '藥物治療',   oldS: '55', newS: '0405' },
      { name: '法規',       oldS: '66', newS: '0406' },
    ],
  },
  medlab: {
    file: 'questions-medlab.json',
    classCode: '308',
    subjects: [
      { name: '臨床生理學與病理學',         oldS: '11', newS: ['0107', '0103'] },
      { name: '臨床血液學與血庫學',         oldS: '22', newS: '0501' },
      { name: '醫學分子檢驗學與臨床鏡檢學', oldS: '33', newS: '0502' },
      { name: '微生物學與臨床微生物學',     oldS: '44', newS: '0503' },
      { name: '生物化學與臨床生化學',       oldS: '55', newS: '0504' },
      { name: '臨床血清免疫學與臨床病毒學', oldS: '66', newS: '0505' },
    ],
  },
  pt: {
    file: 'questions-pt.json',
    classCode: '311',
    subjects: [
      { name: '神經疾病物理治療學',             oldS: '11', newS: '0701' },
      { name: '骨科疾病物理治療學',             oldS: '22', newS: '0702' },
      { name: '心肺疾病與小兒疾病物理治療學',   oldS: '33', newS: '0703' },
      { name: '物理治療基礎學',                 oldS: '44', newS: '0704' },
      { name: '物理治療學概論',                 oldS: '55', newS: '0705' },
      { name: '物理治療技術學',                 oldS: '66', newS: '0706' },
    ],
  },
  ot: {
    file: 'questions-ot.json',
    classCode: '312',
    subjects: [
      { name: '解剖學與生理學',     oldS: '11', newS: '0105' },
      { name: '職能治療學概論',     oldS: '22', newS: '0801' },
      { name: '生理疾病職能治療學', oldS: '33', newS: '0802' },
      { name: '心理疾病職能治療學', oldS: '44', newS: '0803' },
      { name: '小兒疾病職能治療學', oldS: '55', newS: '0804' },
      { name: '職能治療技術學',     oldS: '66', newS: '0805' },
    ],
  },
  nursing: {
    file: 'questions-nursing.json',
    classCode: '101',
    subjects: [
      { name: '基礎醫學',               newS: '0101' },
      { name: '基本護理學與護理行政',   newS: '0102' },
      { name: '內外科護理學',           newS: '0103' },
      { name: '產兒科護理學',           newS: '0104' },
      { name: '精神科與社區衛生護理學', newS: '0105' },
    ],
  },
  nutrition: {
    file: 'questions-nutrition.json',
    classCode: '102',
    subjects: [
      { name: '膳食療養學',         newS: '0201' },
      { name: '團體膳食設計與管理', newS: '0202' },
      { name: '生理學與生物化學',   newS: '0203' },
      { name: '營養學',             newS: '0204' },
      { name: '公共衛生營養學',     newS: '0205' },
      { name: '食品衛生與安全',     newS: '0206' },
    ],
  },
}

// ─── HTTP ───

function fetchPdf(url, retries = 1) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false,
      timeout: 20000,
      headers: { 'User-Agent': UA, 'Accept': 'application/pdf,*/*', 'Referer': 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location
        if (!loc || !loc.startsWith('http')) { res.resume(); return reject(new Error('redirect')) }
        return fetchPdf(loc, retries).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800)
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      const ct = res.headers['content-type'] || ''
      if (!ct.includes('pdf') && !ct.includes('octet')) { res.resume(); return reject(new Error('not-pdf')) }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', (e) => {
      if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800)
      reject(e)
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

// ─── Correction parser (tested on 4 real PDFs) ───

function parseCorrections(text) {
  const corrections = {}
  const norm = text
    .replace(/Ａ/g, 'A').replace(/Ｂ/g, 'B').replace(/Ｃ/g, 'C').replace(/Ｄ/g, 'D')

  // Pattern 1: 送分 (一律給分)
  const voidRe = /第\s*(\d{1,3})\s*題[^，。\n第]*?一律給分/g
  let m
  while ((m = voidRe.exec(norm)) !== null) {
    corrections[parseInt(m[1])] = { kind: 'void' }
  }

  // Pattern 2: 多答案 — 第X題答...給分（支援「或」與「、」分隔）
  const multiRe = /第\s*(\d{1,3})\s*題[^第]*?答([^給第]*?)給分/g
  while ((m = multiRe.exec(norm)) !== null) {
    const num = parseInt(m[1])
    if (corrections[num]) continue
    const letters = [...new Set((m[2].match(/[ABCD]/g) || []))].sort()
    if (letters.length >= 1) {
      corrections[num] = { kind: 'multi', answers: letters.join(',') }
    }
  }

  return corrections
}

// ─── URL builder ───

function buildMUrl(classCode, examCode, s) {
  return `${BASE_URL}?t=M&code=${examCode}&c=${classCode}&s=${s}&q=1`
}

function getSubjectCode(examDef, subjectName, year) {
  const sub = examDef.subjects.find(s => s.name === subjectName)
  if (!sub) return null
  const yearNum = parseInt(year)
  if (yearNum >= 114) {
    const ns = sub.newS
    if (Array.isArray(ns)) return ns   // list of candidates to try
    return ns ? [ns] : null
  } else {
    return sub.oldS ? [sub.oldS] : null
  }
}

// ─── Clear existing corrections (reset to original answer) ───

function resetExistingCorrections(qs) {
  let cleared = 0
  for (const q of qs) {
    if (q.disputed || q.correction_note || q.original_answer) {
      if (q.original_answer) {
        q.answer = q.original_answer
      }
      delete q.disputed
      delete q.correction_note
      delete q.original_answer
      cleared++
    }
  }
  return cleared
}

// ─── Apply corrections to questions ───

function applyCorrection(q, corr) {
  const origAns = q.answer
  if (corr.kind === 'void') {
    q.answer = '送分'
    q.disputed = true
    q.original_answer = origAns
    q.correction_note = `第${q.number}題一律給分（原答案 ${origAns}）`
    return 'void'
  } else {
    q.answer = corr.answers
    q.disputed = true
    q.original_answer = origAns
    q.correction_note = `第${q.number}題更正為 ${corr.answers}（原答案 ${origAns}）`
    return 'multi'
  }
}

// ─── Main ───

async function rescanExam(examId, dryRun) {
  const def = EXAMS[examId]
  if (!def) { console.error(`Unknown exam: ${examId}`); return }

  const filePath = path.join(__dirname, '..', def.file)
  if (!fs.existsSync(filePath)) { console.error(`File not found: ${filePath}`); return }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`  Rescanning: ${examId}`)
  console.log(`${'='.repeat(60)}`)

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const qs = data.questions || data

  // Step 1: Clear existing corrections
  const cleared = resetExistingCorrections(qs)
  console.log(`  🧹 Cleared ${cleared} existing corrections`)

  // Step 2: Collect unique (exam_code, subject) combos
  const combos = new Map()
  for (const q of qs) {
    const key = `${q.roc_year}|${q.session}|${q.exam_code}|${q.subject}`
    if (!combos.has(key)) {
      combos.set(key, { year: q.roc_year, session: q.session, examCode: q.exam_code, subject: q.subject })
    }
  }
  console.log(`  📋 Found ${combos.size} (year, session, subject) combos`)

  // Step 3: For each combo, fetch t=M PDF and parse
  let voidCount = 0, multiCount = 0, pdfHit = 0, pdfMiss = 0
  for (const { year, session, examCode, subject } of combos.values()) {
    const sCodes = getSubjectCode(def, subject, year)
    if (!sCodes) {
      console.log(`  ⚠ ${year}${session} ${subject}: no s code mapping`)
      continue
    }

    let corrections = null
    let usedS = null
    for (const s of sCodes) {
      const url = buildMUrl(def.classCode, examCode, s)
      try {
        const buf = await fetchPdf(url)
        const text = (await pdfParse(buf)).text
        // Verify 類科 matches by checking classCode in header
        corrections = parseCorrections(text)
        usedS = s
        break
      } catch (e) {
        // 302 = no correction PDF, try next s code
      }
    }

    if (corrections === null) {
      pdfMiss++
      continue
    }
    pdfHit++

    const nCorr = Object.keys(corrections).length
    if (nCorr === 0) {
      continue  // PDF exists but no corrections parsed
    }

    // Apply corrections to matching questions
    for (const [numStr, corr] of Object.entries(corrections)) {
      const num = parseInt(numStr)
      const q = qs.find(q =>
        q.roc_year === year &&
        q.session === session &&
        q.subject === subject &&
        q.number === num
      )
      if (!q) {
        console.log(`    ⚠ ${year}${session} ${subject} #${num}: not found in JSON`)
        continue
      }
      const kind = applyCorrection(q, corr)
      if (kind === 'void') voidCount++
      else multiCount++
    }

    console.log(`  ✓ ${year}${session} ${subject} (s=${usedS}): ${nCorr} corrections`)
  }

  console.log(`\n  Summary: ${pdfHit} PDFs hit, ${pdfMiss} miss`)
  console.log(`  Applied: ${voidCount} void, ${multiCount} multi-answer`)

  // Step 4: Write back
  if (dryRun) {
    console.log(`  [DRY RUN] not writing`)
  } else {
    if (data.questions) data.questions = qs
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n')
    console.log(`  💾 Wrote ${def.file}`)
  }
}

// ─── CLI ───

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const examIdx = args.indexOf('--exam')
  if (examIdx === -1) {
    console.error('Usage: node scripts/rescan-corrections.js --exam <examId|all> [--dry-run]')
    process.exit(1)
  }
  const examArg = args[examIdx + 1]
  const examList = examArg === 'all' ? Object.keys(EXAMS) : [examArg]

  for (const examId of examList) {
    await rescanExam(examId, dryRun)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
