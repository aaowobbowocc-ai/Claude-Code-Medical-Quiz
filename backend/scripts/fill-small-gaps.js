#!/usr/bin/env node
/**
 * Fill small per-paper gaps (1-20 missing questions) using cached PDFs.
 *
 * Strategy:
 *   1. For each (exam, exam_code, subject) with missing question numbers:
 *      - Try label-based parser first (A./B./C./D. format common in 101+)
 *      - Fall back to column-aware parser (100年 CBT-style PDFs, 4 options
 *        without labels)
 *   2. Look up correct answer from cached A_/TS_/TM_ PDFs (or download t=S/t=M).
 *   3. Append missing questions to JSON.
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const { parseColumnAware, parseAnswersText, parseAnswersColumnAware } = require('./lib/moex-column-parser.js')

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')

const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')

function get(url) {
  return new Promise(r => {
    https.get(url, { agent: new https.Agent({ rejectUnauthorized: false }) }, x => {
      if (x.statusCode !== 200) { x.destroy(); return r(null) }
      const c = []; x.on('data', d => c.push(d)); x.on('end', () => r(Buffer.concat(c)))
    }).on('error', () => r(null))
  })
}

async function readPdfText(p) {
  const mupdf = await import('mupdf')
  const buf = fs.readFileSync(p)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) txt += '\n' + doc.loadPage(i).toStructuredText('preserve-whitespace').asText()
  return stripPUA(txt)
}

// Parser A: label-based (A./B./C./D.)
function parseLabeled(txt) {
  const matches = [...txt.matchAll(/^\s*(\d{1,3})[.、．]\s*/gm)]
  const questions = []
  for (let i = 0; i < matches.length; i++) {
    const num = parseInt(matches[i][1])
    if (num < 1 || num > 200) continue
    const start = matches[i].index + matches[i][0].length
    const end = i + 1 < matches.length ? matches[i + 1].index : txt.length
    const body = txt.slice(start, end).trim()
    if (body.length < 5) continue
    const optMatches = [...body.matchAll(/^\s*([ABCD])[.、．]\s*/gm)]
    if (optMatches.length < 4) continue
    const options = {}
    for (let j = 0; j < 4; j++) {
      const om = optMatches[j]
      const optStart = om.index + om[0].length
      const optEnd = j + 1 < optMatches.length ? optMatches[j + 1].index : body.length
      options[om[1]] = body.slice(optStart, optEnd).trim().replace(/\s+/g, ' ')
    }
    const question = body.slice(0, optMatches[0].index).trim().replace(/\s+/g, ' ')
    if (question.length < 5) continue
    questions.push({ number: num, question, options })
  }
  return questions
}

async function parseQuestions(pdfPath) {
  const buf = fs.readFileSync(pdfPath)
  const txt = await readPdfText(pdfPath)
  // Try labeled parser first
  let questions = parseLabeled(txt)
  if (questions.length >= 30) return questions
  // Fall back to column-aware (returns object keyed by question number)
  try {
    const cols = await parseColumnAware(buf)
    if (cols && typeof cols === 'object') {
      const result = []
      for (const [num, q] of Object.entries(cols)) {
        if (q && q.question && q.options) {
          result.push({ number: parseInt(num), question: q.question, options: q.options })
        }
      }
      if (result.length > questions.length) return result
    }
  } catch (e) {
    console.log('   column-aware fail:', e.message)
  }
  return questions  // best effort
}

async function getAnswerKey(examCode, c, s, paperCount) {
  // Try cached files first
  for (const t of ['M', 'S', 'A']) {
    const candidates = [
      `T${t}_${examCode}_c${c}_s${s}.pdf`,
      `${t === 'A' ? 'A' : 'T' + t}_${examCode}_c${c}_s${s}.pdf`,
    ]
    for (const fn of candidates) {
      const p = path.join(PDF_CACHE, fn)
      if (fs.existsSync(p) && fs.statSync(p).size > 1000) {
        const txt = await readPdfText(p)
        // Try simple letter sequence
        const letters = (txt.match(/(?<![A-Z0-9])[A-D#](?![A-Z0-9])/g) || [])
        if (letters.length >= paperCount) return letters.slice(0, paperCount).join('')
      }
    }
  }
  // Download
  for (const t of ['S', 'M', 'A']) {
    const url = `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=${t}&code=${examCode}&c=${c}&s=${s}&q=1`
    const buf = await get(url)
    if (!buf || buf.length < 1000) continue
    const fn = path.join(PDF_CACHE, `T${t}_${examCode}_c${c}_s${s}.pdf`)
    fs.writeFileSync(fn, buf)
    const txt = await readPdfText(fn)
    const letters = (txt.match(/(?<![A-Z0-9])[A-D#](?![A-Z0-9])/g) || [])
    if (letters.length >= paperCount) return letters.slice(0, paperCount).join('')
  }
  return null
}

// Discover question PDF for a (exam, exam_code, subject) — search cached files
function findQuestionPdf(examPrefix, examCode, subjectKeyword) {
  const files = fs.readdirSync(PDF_CACHE).filter(f =>
    f.startsWith(examPrefix + '_' + examCode + '_') && f.endsWith('.pdf') && !f.startsWith('A_') && !f.startsWith('T')
  )
  return files.map(f => path.join(PDF_CACHE, f))
}

// Subject name variations for fuzzy matching across years
const SUBJECT_ALIASES = {
  '醫學分子檢驗學與臨床鏡檢學': ['醫學分子檢驗學與臨床鏡檢學', '臨床鏡檢學'],
  '微生物學與臨床微生物學': ['微生物學與臨床微生物學', '微生物學及臨床微生物學', '微生物學'],
  // pharma1: 卷一/二/三 → 藥師 PDF subject names
  '卷一': ['藥理學與藥物化學'],
  '卷二': ['藥物分析與生藥學'],
  '卷三': ['藥劑學'],
  // pharma2
  '調劑與臨床': ['調劑學與臨床藥學'],
  '藥物治療': ['藥物治療學'],
  '法規': ['藥事行政與法規'],
}

async function discoverPdf(examPrefix, examCode, subjectName) {
  const candidates = findQuestionPdf(examPrefix, examCode, subjectName)
  const keywords = SUBJECT_ALIASES[subjectName] || [subjectName]
  for (const p of candidates) {
    const txt = await readPdfText(p)
    if (keywords.some(k => txt.includes(k))) return p
  }
  return null
}

async function fillGap({ jsonFile, examPrefix, examCode, subject, subject_tag, missing, rocYear, session, paperCount }) {
  const pdfPath = await discoverPdf(examPrefix, examCode, subject)
  if (!pdfPath) {
    console.log(`  ❌ ${examCode} ${subject}: no Q PDF`)
    return 0
  }
  // Extract c and s from filename for answer lookup
  const fname = path.basename(pdfPath)
  const csMatch = fname.match(/_c(\w+)_s(\w+)\.pdf$/)
  if (!csMatch) { console.log(`  ❌ can't parse c/s from ${fname}`); return 0 }
  const [, c, s] = csMatch

  const questions = await parseQuestions(pdfPath)
  const answers = await getAnswerKey(examCode, c, s, paperCount)
  if (!answers) { console.log(`  ❌ ${examCode} ${subject}: no answers`); return 0 }

  const filePath = path.join(BACKEND, jsonFile)
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const arr = data.questions || data
  const maxId = arr.reduce((m, q) => {
    const n = typeof q.id === 'number' ? q.id : parseInt(String(q.id).replace(/\D/g, '')) || 0
    return Math.max(m, n)
  }, 0)
  let nextId = maxId + 1
  // Build dedup set so re-runs are idempotent
  const existing = new Set(arr.filter(q => q.exam_code === examCode && q.subject === subject).map(q => q.number))

  let added = 0
  for (const num of missing) {
    if (existing.has(num)) continue
    const found = questions.find(q => q.number === num)
    if (!found) continue
    if (!found.options || Object.keys(found.options).length !== 4) continue
    if (Object.values(found.options).some(v => !v || v.length < 2)) continue
    const ans = answers[num - 1]
    if (!ans || ans === '#') continue
    existing.add(num)
    arr.push({
      id: nextId++,
      roc_year: rocYear,
      session,
      exam_code: examCode,
      subject,
      subject_tag,
      subject_name: subject,
      stage_id: 0,
      number: num,
      question: found.question,
      options: found.options,
      answer: ans,
      explanation: '',
    })
    added++
  }
  arr.sort((a, b) => {
    if (a.exam_code !== b.exam_code) return a.exam_code.localeCompare(b.exam_code)
    if (a.subject !== b.subject) return a.subject.localeCompare(b.subject)
    return (a.number || 0) - (b.number || 0)
  })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
  console.log(`  ✓ ${examCode} ${subject}: +${added}/${missing.length}`)
  return added
}

// Add dental2 + extras to existing SUBJECT_ALIASES (defined earlier as const)
SUBJECT_ALIASES['卷一'] = (SUBJECT_ALIASES['卷一'] || []).concat(['口腔解剖學', '牙體形態學', '口腔組織', '生物化學'])
SUBJECT_ALIASES['卷二'] = (SUBJECT_ALIASES['卷二'] || []).concat(['口腔病理學', '牙科材料學', '口腔微生物學', '牙科藥理學'])
SUBJECT_ALIASES['卷三'] = (SUBJECT_ALIASES['卷三'] || []).concat(['齒內治療學', '牙體復形學', '牙周病學'])
SUBJECT_ALIASES['卷四'] = ['口腔顎面外科學', '牙科放射線學']

// Define gaps to fill
const GAPS = [
  // medlab
  { jsonFile: 'questions-medlab.json', examPrefix: 'medlab', examCode: '100140', subject: '臨床生理學與病理學', subject_tag: 'paper1', missing: [14,17,19,21,26,27,30,35,39,42,44,47,48,50,53,55,58,59], rocYear: '100', session: '第二次', paperCount: 80 },
  { jsonFile: 'questions-medlab.json', examPrefix: 'medlab', examCode: '101110', subject: '臨床生理學與病理學', subject_tag: 'paper1', missing: [5,18,26,75], rocYear: '101', session: '第二次', paperCount: 80 },
  { jsonFile: 'questions-medlab.json', examPrefix: 'medlab', examCode: '101110', subject: '生物化學與臨床生化學', subject_tag: 'paper5', missing: [3,19,34,55], rocYear: '101', session: '第二次', paperCount: 80 },
  { jsonFile: 'questions-medlab.json', examPrefix: 'medlab', examCode: '101110', subject: '臨床血清免疫學與臨床病毒學', subject_tag: 'paper6', missing: [3,46,69], rocYear: '101', session: '第二次', paperCount: 80 },
  { jsonFile: 'questions-medlab.json', examPrefix: 'medlab', examCode: '102030', subject: '臨床生理學與病理學', subject_tag: 'paper1', missing: [22,41], rocYear: '102', session: '第一次', paperCount: 80 },
  { jsonFile: 'questions-medlab.json', examPrefix: 'medlab', examCode: '101110', subject: '醫學分子檢驗學與臨床鏡檢學', subject_tag: 'paper3', missing: [12], rocYear: '101', session: '第二次', paperCount: 80 },
  { jsonFile: 'questions-medlab.json', examPrefix: 'medlab', examCode: '101110', subject: '微生物學與臨床微生物學', subject_tag: 'paper4', missing: [59], rocYear: '101', session: '第二次', paperCount: 80 },
  { jsonFile: 'questions-medlab.json', examPrefix: 'medlab', examCode: '103020', subject: '微生物學與臨床微生物學', subject_tag: 'paper4', missing: [5], rocYear: '103', session: '第一次', paperCount: 80 },
  { jsonFile: 'questions-medlab.json', examPrefix: 'medlab', examCode: '107020', subject: '醫學分子檢驗學與臨床鏡檢學', subject_tag: 'paper3', missing: [14], rocYear: '107', session: '第一次', paperCount: 80 },
  { jsonFile: 'questions-medlab.json', examPrefix: 'medlab', examCode: '110020', subject: '醫學分子檢驗學與臨床鏡檢學', subject_tag: 'paper3', missing: [51], rocYear: '110', session: '第一次', paperCount: 80 },
  { jsonFile: 'questions-medlab.json', examPrefix: 'medlab', examCode: '115020', subject: '臨床生理學與病理學', subject_tag: 'paper1', missing: [7], rocYear: '115', session: '第一次', paperCount: 80 },
  // pharma1
  { jsonFile: 'questions-pharma1.json', examPrefix: 'pharma1', examCode: '100140', subject: '卷一', subject_tag: 'paper1', missing: [74], rocYear: '100', session: '第二次', paperCount: 80 },
  { jsonFile: 'questions-pharma1.json', examPrefix: 'pharma1', examCode: '100140', subject: '卷二', subject_tag: 'paper2', missing: [17,24], rocYear: '100', session: '第二次', paperCount: 80 },
  // dental2 卷三/卷四 散缺 (2026-05-06)
  { jsonFile: 'questions-dental2.json', examPrefix: 'dental2', examCode: '100020', subject: '卷四', subject_tag: 'paper4', missing: [14,18,61,80], rocYear: '100', session: '第一次', paperCount: 80 },
  { jsonFile: 'questions-dental2.json', examPrefix: 'dental2', examCode: '101100', subject: '卷四', subject_tag: 'paper4', missing: [7,11,59,80], rocYear: '101', session: '第二次', paperCount: 80 },
  { jsonFile: 'questions-dental2.json', examPrefix: 'dental2', examCode: '102020', subject: '卷四', subject_tag: 'paper4', missing: [21,80], rocYear: '102', session: '第一次', paperCount: 80 },
  { jsonFile: 'questions-dental2.json', examPrefix: 'dental2', examCode: '102100', subject: '卷四', subject_tag: 'paper4', missing: [80], rocYear: '102', session: '第二次', paperCount: 80 },
  { jsonFile: 'questions-dental2.json', examPrefix: 'dental2', examCode: '103020', subject: '卷四', subject_tag: 'paper4', missing: [10,22,27,51,67,80], rocYear: '103', session: '第一次', paperCount: 80 },
  { jsonFile: 'questions-dental2.json', examPrefix: 'dental2', examCode: '103090', subject: '卷四', subject_tag: 'paper4', missing: [19,80], rocYear: '103', session: '第二次', paperCount: 80 },
  { jsonFile: 'questions-dental2.json', examPrefix: 'dental2', examCode: '104020', subject: '卷三', subject_tag: 'paper3', missing: [53], rocYear: '104', session: '第一次', paperCount: 80 },
  { jsonFile: 'questions-dental2.json', examPrefix: 'dental2', examCode: '105020', subject: '卷四', subject_tag: 'paper4', missing: [20], rocYear: '105', session: '第一次', paperCount: 80 },
  { jsonFile: 'questions-dental2.json', examPrefix: 'dental2', examCode: '105100', subject: '卷二', subject_tag: 'paper2', missing: [14], rocYear: '105', session: '第二次', paperCount: 80 },
  // pt 100-1 物理治療基礎學 Q30
  { jsonFile: 'questions-pt.json', examPrefix: 'pt', examCode: '100030', subject: '物理治療基礎學', subject_tag: 'paper1', missing: [30], rocYear: '100', session: '第一次', paperCount: 80 },
  // pharma2 藥物治療 110+ 每年缺 Q55-80（原 scraper 切在 Q54）
  ...['110020','111020','111100','112020','112100','113020','113090','114020','114090','115020'].map(code => ({
    jsonFile: 'questions-pharma2.json',
    examPrefix: 'pharma2',
    examCode: code,
    subject: '藥物治療',
    subject_tag: 'paper2',
    missing: Array.from({length: 26}, (_, i) => 55 + i),
    rocYear: code.slice(0, 3),
    session: parseInt(code.slice(3, 6)) > 50 ? '第二次' : '第一次',
    paperCount: 80,
  })),
  // pharma2
  { jsonFile: 'questions-pharma2.json', examPrefix: 'pharma2', examCode: '100140', subject: '調劑與臨床', subject_tag: 'paper1', missing: [75], rocYear: '100', session: '第二次', paperCount: 80 },
  // vet
  { jsonFile: 'questions-vet.json', examPrefix: 'vet', examCode: '104090', subject: '獸醫公共衛生學', subject_tag: 'public_health', missing: [52,63,74], rocYear: '104', session: '第二次', paperCount: 80 },
  { jsonFile: 'questions-vet.json', examPrefix: 'vet', examCode: '104090', subject: '獸醫病理學', subject_tag: 'pathology', missing: [55,68,75], rocYear: '104', session: '第二次', paperCount: 80 },
  { jsonFile: 'questions-vet.json', examPrefix: 'vet', examCode: '104090', subject: '獸醫藥理學', subject_tag: 'pharmacology', missing: [56], rocYear: '104', session: '第二次', paperCount: 80 },
  { jsonFile: 'questions-vet.json', examPrefix: 'vet', examCode: '102020', subject: '獸醫藥理學', subject_tag: 'pharmacology', missing: [1], rocYear: '102', session: '第一次', paperCount: 80 },
  { jsonFile: 'questions-vet.json', examPrefix: 'vet', examCode: '103020', subject: '獸醫普通疾病學', subject_tag: 'general_diseases', missing: [48], rocYear: '103', session: '第一次', paperCount: 80 },
  { jsonFile: 'questions-vet.json', examPrefix: 'vet', examCode: '103090', subject: '獸醫公共衛生學', subject_tag: 'public_health', missing: [9], rocYear: '103', session: '第二次', paperCount: 80 },
  { jsonFile: 'questions-vet.json', examPrefix: 'vet', examCode: '103090', subject: '獸醫普通疾病學', subject_tag: 'general_diseases', missing: [18], rocYear: '103', session: '第二次', paperCount: 80 },
  { jsonFile: 'questions-vet.json', examPrefix: 'vet', examCode: '105100', subject: '獸醫普通疾病學', subject_tag: 'general_diseases', missing: [47], rocYear: '105', session: '第二次', paperCount: 80 },
  // pharma2 藥物治療 散缺 1 題（2026-05-12）
  { jsonFile: 'questions-pharma2.json', examPrefix: 'pharma2', examCode: '110020', subject: '藥物治療', subject_tag: 'therapeutics', missing: [79], rocYear: '110', session: '第一次', paperCount: 80 },
  { jsonFile: 'questions-pharma2.json', examPrefix: 'pharma2', examCode: '112020', subject: '藥物治療', subject_tag: 'pharmacotherapy', missing: [73], rocYear: '112', session: '第一次', paperCount: 80 },
  { jsonFile: 'questions-pharma2.json', examPrefix: 'pharma2', examCode: '114090', subject: '藥物治療', subject_tag: 'therapeutics', missing: [77], rocYear: '114', session: '第二次', paperCount: 80 },
  { jsonFile: 'questions-pharma2.json', examPrefix: 'pharma2', examCode: '115020', subject: '藥物治療', subject_tag: 'therapeutics', missing: [77], rocYear: '115', session: '第一次', paperCount: 80 },
  // nursing 散缺（2026-05-12）
  { jsonFile: 'questions-nursing.json', examPrefix: 'nursing', examCode: '102030', subject: '精神科與社區衛生護理學', subject_tag: 'psychiatric_nursing', missing: [47, 72], rocYear: '102', session: '第一次', paperCount: 80 },
  { jsonFile: 'questions-nursing.json', examPrefix: 'nursing', examCode: '101110', subject: '基本護理學與護理行政', subject_tag: 'fundamental_nursing', missing: [41], rocYear: '101', session: '第二次', paperCount: 80 },
  { jsonFile: 'questions-nursing.json', examPrefix: 'nursing', examCode: '101110', subject: '產兒科護理學', subject_tag: 'obstetric_nursing', missing: [72], rocYear: '101', session: '第二次', paperCount: 80 },
  { jsonFile: 'questions-nursing.json', examPrefix: 'nursing', examCode: '101110', subject: '精神科與社區衛生護理學', subject_tag: 'psychiatric_nursing', missing: [28], rocYear: '101', session: '第二次', paperCount: 80 },
  { jsonFile: 'questions-nursing.json', examPrefix: 'nursing', examCode: '104030', subject: '基礎醫學', subject_tag: 'paper1', missing: [60], rocYear: '104', session: '第一次', paperCount: 80 },
]

;(async () => {
  console.log('=== Fill small gaps ===\n')
  let total = 0
  for (const g of GAPS) {
    total += await fillGap(g)
  }
  console.log(`\nTOTAL added: ${total}`)
})().catch(e => { console.error(e); process.exit(1) })
