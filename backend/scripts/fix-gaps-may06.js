#!/usr/bin/env node
/**
 * Fix specific known partial gaps (2026-05-06):
 *   - vet 104-2 獸醫公共衛生學: Q51-80 (PDF has them, JSON only has Q1-50)
 *
 * Uses already-cached PDFs in _tmp/pdf-cache/.
 */

const fs = require('fs')
const path = require('path')

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')

const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')

async function readPdf(p) {
  const mupdf = await import('mupdf')
  const buf = fs.readFileSync(p)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) txt += '\n' + doc.loadPage(i).toStructuredText('preserve-whitespace').asText()
  return stripPUA(txt)
}

// Parse questions with format:
//   NN.題幹文字...
//   A.選項1
//   B.選項2
//   C.選項3
//   D.選項4
function parseQuestions(txt) {
  const questions = []
  // Find all question-number positions, then slice between consecutive ones
  const matches = [...txt.matchAll(/^\s*(\d{1,3})[.、．]\s*/gm)]
  for (let i = 0; i < matches.length; i++) {
    const num = parseInt(matches[i][1])
    if (num < 1 || num > 200) continue
    const start = matches[i].index + matches[i][0].length
    const end = i + 1 < matches.length ? matches[i + 1].index : txt.length
    const body = txt.slice(start, end).trim()
    // Skip if too short
    if (body.length < 5) continue
    // Parse options A./B./C./D.
    const optMatches = [...body.matchAll(/^\s*([ABCD])[.、．]\s*/gm)]
    if (optMatches.length < 4) continue
    const options = {}
    for (let j = 0; j < 4; j++) {
      const om = optMatches[j]
      const optStart = om.index + om[0].length
      const optEnd = j + 1 < optMatches.length ? optMatches[j + 1].index : body.length
      options[om[1]] = body.slice(optStart, optEnd).trim().replace(/\s+/g, ' ')
    }
    // Question = body before first option
    const firstOptIdx = optMatches[0].index
    const question = body.slice(0, firstOptIdx).trim().replace(/\s+/g, ' ')
    if (question.length < 5) continue
    questions.push({ number: num, question, options })
  }
  return questions
}

// Parse answer key from A_ PDF (2-row column-major format used in 100-105)
// Look for sequences of A-D# letters; for 80-Q exam expect 8 rows.
function parseAnswerKey(txt) {
  const ansBlock = txt.match(/答案[:：\s]+([\s\S]+?)(?=備註|備\s+註|$)/)
  if (!ansBlock) return null
  // Get rows of 5-10 letters separated by whitespace (handle "A B C D" or "ABCD")
  // Try simple approach: collect all A-D letters
  const letters = (ansBlock[1].match(/[A-D#]/g) || [])
  if (letters.length >= 80) return letters.slice(0, 80).join('')
  return null
}

async function fixVet104q2GongWei() {
  const pdfPath = path.join(PDF_CACHE, 'vet_104090_c314_s66.pdf')
  const ansPath = path.join(PDF_CACHE, 'A_vet_104090_c314_s66.pdf') // may not exist
  if (!fs.existsSync(pdfPath)) { console.log('no question PDF'); return }

  const qtxt = await readPdf(pdfPath)
  const questions = parseQuestions(qtxt)
  console.log(`  parsed ${questions.length} questions from PDF`)

  // Get answer key — try _tmp cache, then download
  let answers = null
  if (fs.existsSync(ansPath)) {
    const atxt = await readPdf(ansPath)
    answers = parseAnswerKey(atxt)
  }
  if (!answers) {
    console.log('  ⚠️ no answer key — downloading…')
    const https = require('https')
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    const buf = await new Promise((r) => {
      https.get('https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=A&code=104090&c=314&s=66&q=1',
        { agent: new https.Agent({ rejectUnauthorized: false }) },
        x => { if (x.statusCode !== 200) { x.destroy(); return r(null) }
          const c = []; x.on('data', d => c.push(d)); x.on('end', () => r(Buffer.concat(c))) })
        .on('error', () => r(null))
    })
    if (buf) {
      fs.writeFileSync(ansPath, buf)
      const atxt = await readPdf(ansPath)
      answers = parseAnswerKey(atxt)
    }
  }
  if (!answers) { console.log('  ❌ could not get answers'); return }
  console.log(`  parsed ${answers.length} answer chars`)

  // Build new questions for Q51-80
  const filePath = path.join(BACKEND, 'questions-vet.json')
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const arr = data.questions || data
  const existing = new Set(arr.filter(q => q.exam_code === '104090' && q.subject === '獸醫公共衛生學').map(q => q.number))
  const maxId = arr.reduce((m, q) => {
    const n = typeof q.id === 'number' ? q.id : parseInt(String(q.id).replace(/\D/g, '')) || 0
    return Math.max(m, n)
  }, 0)

  let added = 0
  let nextId = maxId + 1
  for (const q of questions) {
    if (q.number < 51 || q.number > 80) continue
    if (existing.has(q.number)) continue
    const ans = answers[q.number - 1]
    if (!ans || ans === '#') continue
    arr.push({
      id: nextId++,
      roc_year: '104',
      session: '第二次',
      exam_code: '104090',
      subject: '獸醫公共衛生學',
      subject_tag: 'public_health',
      subject_name: '獸醫公共衛生學',
      stage_id: 0,
      number: q.number,
      question: q.question,
      options: q.options,
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
  console.log(`  ✓ vet 104-2 公衛: +${added} questions`)
}

async function fixGenericGap({ jsonFile, examCode, subject, subject_tag, qPdfPath, aPdfPath, rocYear, session, paperCount }) {
  if (!fs.existsSync(qPdfPath)) { console.log(`  ⚠️ no Q PDF: ${qPdfPath}`); return }

  const qtxt = await readPdf(qPdfPath)
  const questions = parseQuestions(qtxt)
  let answers = null
  if (fs.existsSync(aPdfPath)) {
    const atxt = await readPdf(aPdfPath)
    answers = parseAnswerKey(atxt)
  }
  if (!answers) { console.log('  ❌ no answer key'); return }

  const filePath = path.join(BACKEND, jsonFile)
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const arr = data.questions || data
  const existing = new Set(arr.filter(q => q.exam_code === examCode && q.subject === subject).map(q => q.number))
  const maxId = arr.reduce((m, q) => {
    const n = typeof q.id === 'number' ? q.id : parseInt(String(q.id).replace(/\D/g, '')) || 0
    return Math.max(m, n)
  }, 0)

  let added = 0
  let nextId = maxId + 1
  for (const q of questions) {
    if (q.number < 1 || q.number > paperCount) continue
    if (existing.has(q.number)) continue
    const ans = answers[q.number - 1]
    if (!ans || ans === '#') continue
    arr.push({
      id: nextId++,
      roc_year: rocYear,
      session,
      exam_code: examCode,
      subject,
      subject_tag,
      subject_name: subject,
      stage_id: 0,
      number: q.number,
      question: q.question,
      options: q.options,
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
  console.log(`  ✓ ${jsonFile} ${examCode} ${subject}: +${added} questions`)
}

(async () => {
  console.log('=== Fix gaps 2026-05-06 ===\n')

  // vet 104-2 — re-parse all 6 papers (some have small gaps)
  console.log('--- vet 104-2 ---')
  const vetMap = [
    ['11', '獸醫病理學', 'pathology'],
    ['22', '獸醫藥理學', 'pharmacology'],
    ['33', '獸醫實驗診斷學', 'lab_diagnosis'],
    ['44', '獸醫普通疾病學', 'general_diseases'],
    ['55', '獸醫傳染病學', 'infectious_diseases'],
    ['66', '獸醫公共衛生學', 'public_health'],
  ]
  for (const [s, subj, tag] of vetMap) {
    await fixGenericGap({
      jsonFile: 'questions-vet.json',
      examCode: '104090',
      subject: subj,
      subject_tag: tag,
      qPdfPath: path.join(PDF_CACHE, `vet_104090_c314_s${s}.pdf`),
      aPdfPath: path.join(PDF_CACHE, `A_vet_104090_c314_s${s}.pdf`),
      rocYear: '104',
      session: '第二次',
      paperCount: 80,
    })
  }

  // audiologist 104-2 — 6 papers (50 each), parse all and merge
  console.log('--- audiologist 104-2 ---')
  const audMap = [
    ['0901', '基礎聽力科學', 'paper1'],
    ['0902', '行為聽力學', 'paper2'],
    ['0903', '電生理聽力學', 'paper3'],
    ['0904', '聽覺輔具原理與實務學', 'paper4'],
    ['0905', '聽覺與平衡系統之創健與復健學', 'paper5'],
    ['0906', '聽語溝通障礙學（包括專業倫理）', 'paper6'],
  ]
  for (const [s, subj, tag] of audMap) {
    await fixGenericGap({
      jsonFile: 'questions-audiologist.json',
      examCode: '104100',
      subject: subj,
      subject_tag: tag,
      qPdfPath: path.join(PDF_CACHE, `audiologist_104100_c110_s${s}.pdf`),
      aPdfPath: path.join(PDF_CACHE, `A_audiologist_104100_c110_s${s}.pdf`),
      rocYear: '104',
      session: '第二次',
      paperCount: 50,
    })
  }

  // speech-therapist 107-1
  console.log('\n--- speech-therapist 107-1 ---')
  // Need to find PDF s codes — TBD
})().catch(e => { console.error(e); process.exit(1) })
