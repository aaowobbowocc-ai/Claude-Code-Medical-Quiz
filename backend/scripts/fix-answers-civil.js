#!/usr/bin/env node
// Fix wrong answers in civil-senior, judicial, lawyer1 question banks.
// The original scrapers used pdf-parse text mode to parse answer PDFs,
// but tabular-format answer PDFs don't produce correct sequential text.
// This script re-downloads answer PDFs and uses position-based parsing.
// Also fixes vocab-grid questions where options are shifted by 1.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfjsLib = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')

const BACKEND = path.resolve(__dirname, '..')
const CACHE = path.join(BACKEND, '_tmp', 'pdf-cache-fix')
const DRY_RUN = process.argv.includes('--dry')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true })

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
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
      const cs = []
      res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    })
    req.on('error', e => retries > 0 ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800) : reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

// Position-based answer PDF parser
async function parseAnswersPDF(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const allItems = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    for (const item of content.items) {
      allItems.push({ x: Math.round(item.transform[4]), y: Math.round(item.transform[5]), page: p, str: item.str })
    }
  }
  allItems.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)

  // Group into rows
  const rows = []
  let curY = null, curRow = []
  for (const item of allItems) {
    if (curY === null || Math.abs(item.y - curY) > 3) {
      if (curRow.length) rows.push(curRow)
      curRow = [item]; curY = item.y
    } else { curRow.push(item) }
  }
  if (curRow.length) rows.push(curRow)

  const answers = {}

  // Method 1: Tabular format (第N題 row followed by answer letter row)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const nums = []
    for (const item of row) {
      const m = item.str.match(/第(\d+)題/)
      if (m) nums.push({ num: parseInt(m[1]), x: item.x })
    }
    if (nums.length >= 3 && i + 1 < rows.length) {
      const ansRow = rows[i + 1]
      const letters = ansRow.filter(r => /^[ABCD]$/.test(r.str.trim())).sort((a, b) => a.x - b.x)
      nums.sort((a, b) => a.x - b.x)
      for (let j = 0; j < Math.min(nums.length, letters.length); j++) {
        answers[nums[j].num] = letters[j].str.trim()
      }
    }
  }
  if (Object.keys(answers).length >= 5) return answers

  // Method 2: Fullwidth continuous format (答案ＡＢＣＤ...)
  const fullText = allItems.map(r => r.str).join('')
  const fw = /答案\s*([ＡＢＣＤ]+)/g
  let m, n = 1
  while ((m = fw.exec(fullText)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) answers[n++] = k
    }
  }
  return answers
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── Exam definitions ───
const EXAMS = {
  'questions-civil-senior.json': {
    sessions: [
      { year: '106', code: '106090' },
      { year: '107', code: '107090' },
      { year: '108', code: '108090' },
      { year: '109', code: '109090' },
      { year: '110', code: '110090' },
      { year: '111', code: '111090' },
      { year: '112', code: '112090' },
      { year: '113', code: '113080' },
      { year: '114', code: '114080' },
    ],
    subjects: [
      { c: '201', s: '0401', tag: 'law_knowledge_english', onlyYears: ['114'] },
      { c: '201', s: '0101', tag: 'chinese', onlyYears: ['106', '108', '114'] },
      { c: '301', s: '0101', tag: 'chinese', onlyYears: ['107', '109', '110', '111', '112', '113'] },
      { c: '301', s: '0301', tag: 'admin_studies', onlyYears: ['111', '112'] },
      { c: '301', s: '0303', tag: 'admin_studies', onlyYears: ['113'] },
      { c: '201', s: '0303', tag: 'admin_studies', onlyYears: ['114'] },
      { c: '301', s: '0403', tag: 'admin_law', onlyYears: ['111', '112', '113'] },
      { c: '201', s: '0403', tag: 'admin_law', onlyYears: ['114'] },
    ],
  },
  'questions-judicial.json': {
    sessions: [
      { year: '113', code: '113120' },
      { year: '114', code: '114120' },
    ],
    subjects: [
      { c: '101', s: '0309', tag: 'law_knowledge_english' },
      { c: '101', s: '0101', tag: 'chinese' },
    ],
  },
  'questions-lawyer1.json': {
    sessions: [
      { year: '105', code: '105110' },
      { year: '106', code: '106120' },
      { year: '107', code: '107120' },
      { year: '108', code: '108120' },
      { year: '109', code: '109120' },
      { year: '110', code: '110120' },
      { year: '111', code: '111120' },
      { year: '112', code: '112120' },
      { year: '113', code: '113110' },
      { year: '114', code: '114110' },
    ],
    subjects: [
      { c: '301', s: '0101', tag: 'comprehensive_law_1' },
      { c: '301', s: '0201', tag: 'comprehensive_law_2' },
      { c: '301', s: '0202', tag: 'comprehensive_law_3' },
      { c: '301', s: '0301', tag: 'comprehensive_law_4' },
    ],
  },
  'questions-customs.json': {
    sessions: [
      { year: '108', code: '108050' },
      { year: '109', code: '109050' },
      { year: '110', code: '110050' },
      { year: '111', code: '111050' },
      { year: '112', code: '112050' },
      { year: '113', code: '113040' },
      { year: '114', code: '114040' },
    ],
    subjects: [
      // law_knowledge subject code changes per year
      { c: '101', s: '0307', tag: 'law_knowledge', onlyYears: ['108'] },
      { c: '101', s: '0308', tag: 'law_knowledge', onlyYears: ['109', '110', '112'] },
      { c: '101', s: '0310', tag: 'law_knowledge', onlyYears: ['111'] },
      { c: '101', s: '0306', tag: 'law_knowledge', onlyYears: ['113'] },
      { c: '101', s: '0305', tag: 'law_knowledge', onlyYears: ['114'] },
      { c: '101', s: '0201', tag: 'english' },
      { c: '101', s: '0101', tag: 'chinese' },
    ],
  },
  'questions-social-worker.json': {
    sessions: [
      // c=107 for 106-109
      { year: '106', code: '106030' },
      { year: '106', code: '106110' },
      { year: '107', code: '107030' },
      { year: '107', code: '107110' },
      { year: '108', code: '108020' },
      { year: '108', code: '108110' },
      { year: '109', code: '109030' },
      { year: '109', code: '109110' },
      // c=105 for 110-111
      { year: '110', code: '110030' },
      { year: '110', code: '110111' },
      { year: '111', code: '111030' },
      { year: '111', code: '111110' },
      // c=103 for 112-115
      { year: '112', code: '112030' },
      { year: '113', code: '113030' },
      { year: '114', code: '114030' },
      { year: '115', code: '115030' },
    ],
    subjects: [
      // c=107 (106-109)
      { c: '107', s: '0601', tag: 'social_work', onlyYears: ['106', '107', '108', '109'] },
      { c: '107', s: '0602', tag: 'social_work_direct', onlyYears: ['106', '107', '108', '109'] },
      { c: '107', s: '0603', tag: 'social_work_mgmt', onlyYears: ['106', '107', '108', '109'] },
      // c=105 (110-111)
      { c: '105', s: '0601', tag: 'social_work', onlyYears: ['110', '111'] },
      { c: '105', s: '0602', tag: 'social_work_direct', onlyYears: ['110', '111'] },
      { c: '105', s: '0603', tag: 'social_work_mgmt', onlyYears: ['110', '111'] },
      // c=103 (112-115)
      { c: '103', s: '0301', tag: 'social_work', onlyYears: ['112', '113', '114', '115'] },
      { c: '103', s: '0302', tag: 'social_work_direct', onlyYears: ['112', '113', '114', '115'] },
      { c: '103', s: '0303', tag: 'social_work_mgmt', onlyYears: ['112', '113', '114', '115'] },
    ],
  },
}

// ─── Vocab-grid option shift detection ───
// Checks if a question looks like a shifted vocab-grid entry:
// Q = single English word, A/B/C = English words, D = empty
function isShiftedVocabGrid(q) {
  if (!q.options) return false
  const opts = q.options
  if (opts.D && opts.D.trim()) return false // D is not empty
  if (!opts.A || !opts.B || !opts.C) return false
  // Q should be a single English word (or short phrase)
  if (!q.question || !/^[a-zA-Z\s'-]+$/.test(q.question.trim())) return false
  // A/B/C should also be English words
  for (const k of ['A', 'B', 'C']) {
    if (!/^[a-zA-Z\s'-]+$/.test(opts[k].trim())) return false
  }
  return true
}

async function main() {
  let totalFixed = 0, totalAnswerFixes = 0, totalVocabFixes = 0

  for (const [filename, def] of Object.entries(EXAMS)) {
    const filePath = path.join(BACKEND, filename)
    if (!fs.existsSync(filePath)) {
      console.log(`⚠ ${filename} not found, skipping`)
      continue
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    const questions = data.questions || (Array.isArray(data) ? data : [])

    console.log(`\n═══ ${filename} (${questions.length} questions) ═══`)

    let fileChanged = false

    for (const sess of def.sessions) {
      for (const sub of def.subjects) {
        if (sub.onlyYears && !sub.onlyYears.includes(sess.year)) continue

        const cacheKey = `${filename.replace('.json', '')}_S_${sess.code}_c${sub.c}_s${sub.s}`
        const cachePath = path.join(CACHE, cacheKey + '.pdf')

        // Download answer PDF if not cached
        let aBuf
        if (fs.existsSync(cachePath)) {
          aBuf = fs.readFileSync(cachePath)
        } else {
          const url = `${BASE}?t=S&code=${sess.code}&c=${sub.c}&s=${sub.s}&q=1`
          try {
            console.log(`  📥 Downloading answers ${sess.code} ${sub.tag}...`)
            aBuf = await fetchPdf(url)
            fs.writeFileSync(cachePath, aBuf)
            await sleep(500)
          } catch (e) {
            console.log(`  ⚠ Download failed ${sess.code} ${sub.tag}: ${e.message}`)
            continue
          }
        }

        // Parse answers with position-based method
        const pdfAnswers = await parseAnswersPDF(aBuf)
        const ansCount = Object.keys(pdfAnswers).length

        // Find matching questions
        const matchQ = questions.filter(q => q.exam_code === sess.code && q.subject_tag === sub.tag)
        if (matchQ.length === 0) continue

        let answerFixes = 0, vocabFixes = 0

        for (const q of matchQ) {
          const correctAnswer = pdfAnswers[q.number]

          // Fix vocab-grid shifted options
          if (isShiftedVocabGrid(q) && correctAnswer) {
            const oldQ = q.question
            const oldA = q.options.A
            const oldB = q.options.B
            const oldC = q.options.C

            if (!DRY_RUN) {
              // Shift: Q→A, A→B, B→C, C→D
              q.options.A = oldQ
              q.options.B = oldA
              q.options.C = oldB
              q.options.D = oldC
              q.question = `第${q.number}題` // Set generic stem
            }
            vocabFixes++
            fileChanged = true
          }

          // Fix answer
          if (correctAnswer && q.answer !== correctAnswer) {
            if (!DRY_RUN) {
              q.answer = correctAnswer
            }
            answerFixes++
            fileChanged = true
          }
        }

        if (answerFixes > 0 || vocabFixes > 0) {
          console.log(`  ${sess.code} ${sub.tag}: ${answerFixes} answer fixes, ${vocabFixes} vocab shifts (${ansCount} answers from PDF, ${matchQ.length} stored Q)`)
        }
        totalAnswerFixes += answerFixes
        totalVocabFixes += vocabFixes
      }
    }

    if (fileChanged && !DRY_RUN) {
      if (data.questions) data.total = data.questions.length
      const tmp = filePath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
      fs.renameSync(tmp, filePath)
      console.log(`  💾 Saved ${filename}`)
    }
  }

  totalFixed = totalAnswerFixes + totalVocabFixes
  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}總計: ${totalAnswerFixes} answers fixed, ${totalVocabFixes} vocab shifted`)
}

main().catch(e => { console.error(e); process.exit(1) })
