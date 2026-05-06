#!/usr/bin/env node
/**
 * Auto-discover and fill ALL small per-paper gaps across exams.
 *
 * Workflow:
 *   1. Audit each exam JSON against config — find papers missing 1-10 questions
 *   2. For each (exam, exam_code, subject), discover the PDF in cache
 *   3. Try label-based parser → fall back to column-aware parser
 *   4. Look up answers, add missing Qs to JSON
 *   5. Idempotent (existing.has() dedup check)
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const { parseColumnAware } = require('./lib/moex-column-parser.js')

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')

const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')

const EXAMS = {
  doctor1: 'questions.json', doctor2: 'questions-doctor2.json',
  dental1: 'questions-dental1.json', dental2: 'questions-dental2.json',
  pharma1: 'questions-pharma1.json', pharma2: 'questions-pharma2.json',
  nursing: 'questions-nursing.json', nutrition: 'questions-nutrition.json',
  medlab: 'questions-medlab.json', pt: 'questions-pt.json', ot: 'questions-ot.json',
  radiology: 'questions-radiology.json', tcm1: 'questions-tcm1.json', tcm2: 'questions-tcm2.json',
  vet: 'questions-vet.json', 'social-worker': 'questions-social-worker.json',
  audiologist: 'questions-audiologist.json', 'speech-therapist': 'questions-speech-therapist.json',
}

// Subject aliases (PDF heading vs JSON subject can differ)
const SUBJECT_ALIASES = {
  '醫學分子檢驗學與臨床鏡檢學': ['臨床鏡檢學'],
  '微生物學與臨床微生物學': ['微生物學及臨床微生物學', '微生物學'],
  '卷一': ['醫學(一)', '牙醫學(一)', '藥理學與藥物化學', '物理治療基礎學', '口腔解剖學', '牙體形態學'],
  '卷二': ['醫學(二)', '牙醫學(二)', '藥物分析與生藥學', '物理治療學概論', '口腔病理學'],
  '卷三': ['醫學(三)', '牙醫學(三)', '藥劑學', '物理治療技術學', '齒內治療學'],
  '卷四': ['醫學(四)', '牙醫學(四)', '神經疾病物理治療學', '口腔顎面外科學'],
  '卷五': ['醫學(五)', '牙醫學(五)'],
  '卷六': ['醫學(六)', '牙醫學(六)'],
  '調劑與臨床': ['調劑學與臨床藥學'],
  '藥物治療': ['藥物治療學'],
  '法規': ['藥事行政與法規'],
  // speech-therapist paper6 113年起改名「溝通障礙總論」(同份試卷)
  '聽力學與輔助溝通系統（包括專業倫理）': ['聽力學與輔助溝通系統', '溝通障礙總論'],
  '聽力學與輔助溝通系統': ['溝通障礙總論'],
}

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
  let questions = parseLabeled(txt)
  if (questions.length >= 30) return questions
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
  } catch {}
  return questions
}

async function getAnswerKey(examCode, c, s, paperCount, examPrefix) {
  // Try cached: T*_examCode_c_s.pdf (correction/standard) OR examPrefix_examCode_c_s_S.pdf (legacy naming)
  const candidates = [
    `TM_${examCode}_c${c}_s${s}.pdf`,
    `TS_${examCode}_c${c}_s${s}.pdf`,
    `A_${examCode}_c${c}_s${s}.pdf`,
    examPrefix && `${examPrefix}_${examCode}_c${c}_s${s}_S.pdf`,
    examPrefix && `A_${examPrefix}_${examCode}_c${c}_s${s}.pdf`,
  ].filter(Boolean)
  for (const fn of candidates) {
    const p = path.join(PDF_CACHE, fn)
    if (fs.existsSync(p) && fs.statSync(p).size > 1000) {
      const txt = await readPdfText(p)
      const letters = (txt.match(/(?<![A-Z0-9])[A-D#](?![A-Z0-9])/g) || [])
      if (letters.length >= paperCount) return letters.slice(0, paperCount).join('')
    }
  }
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

// PDF filename prefixes may differ from examId (e.g. 'speech-therapist' → 'speech')
const PDF_PREFIX_VARIANTS = {
  'speech-therapist': ['speech-therapist', 'speech'],
  'social-worker': ['social-worker', 'social_worker', 'socialworker'],
}

async function discoverPdf(examPrefix, examCode, subjectName) {
  const prefixes = PDF_PREFIX_VARIANTS[examPrefix] || [examPrefix]
  let files = []
  for (const pfx of prefixes) {
    files = files.concat(fs.readdirSync(PDF_CACHE).filter(f =>
      f.startsWith(pfx + '_' + examCode + '_') && f.endsWith('.pdf')
      && !f.startsWith('A_') && !f.startsWith('TM_') && !f.startsWith('TS_')
      && !f.endsWith('_S.pdf')
    ))
  }
  // Strip 括號後綴讓比對寬鬆 (e.g. 聽語溝通障礙學（包括專業倫理）→ 聽語溝通障礙學)
  // 也試「與」「及」分隔的前段（e.g. 聽力學與輔助溝通系統 → 聽力學）
  const stem = subjectName.replace(/[（(].*$/, '').trim()
  const headPart = stem.split(/[與及]/)[0]
  const keywords = [subjectName, stem, headPart, ...(SUBJECT_ALIASES[subjectName] || [])]
  for (const f of files) {
    const p = path.join(PDF_CACHE, f)
    const txt = await readPdfText(p)
    if (keywords.some(k => k && txt.includes(k))) return p
  }
  return null
}

// Audit
function audit() {
  const gaps = []
  for (const [examId, file] of Object.entries(EXAMS)) {
    const cfg = JSON.parse(fs.readFileSync(path.join(BACKEND, 'exam-configs', examId + '.json'), 'utf8'))
    const expByPaper = {}
    for (const p of cfg.papers) expByPaper[p.subject] = { count: p.count, tag: p.id }
    const data = JSON.parse(fs.readFileSync(path.join(BACKEND, file), 'utf8'))
    const arr = data.questions || data
    const grp = {}
    for (const q of arr) {
      const k = q.exam_code + '|' + q.subject
      grp[k] = grp[k] || []
      grp[k].push(q)
    }
    for (const [k, qs] of Object.entries(grp)) {
      const [code, subj] = k.split('|')
      const exp = expByPaper[subj]
      if (!exp) continue
      const gap = exp.count - qs.length
      if (gap < 1 || gap > 10) continue
      const have = new Set(qs.map(q => q.number))
      const missing = []
      for (let i = 1; i <= exp.count; i++) if (!have.has(i)) missing.push(i)
      const sample = qs[0]
      gaps.push({
        examId, jsonFile: file, examCode: code, subject: subj, subject_tag: exp.tag,
        missing, paperCount: exp.count,
        rocYear: sample?.roc_year || code.slice(0, 3),
        session: sample?.session || (parseInt(code.slice(3, 6)) > 50 ? '第二次' : '第一次'),
      })
    }
  }
  return gaps
}

async function fillGap(gap) {
  const pdfPath = await discoverPdf(gap.examId, gap.examCode, gap.subject)
  if (!pdfPath) return { status: 'NO_PDF', added: 0 }
  const fname = path.basename(pdfPath)
  const csMatch = fname.match(/_c(\w+)_s(\w+?)(?:_Q)?\.pdf$/)
  if (!csMatch) return { status: 'NO_CS', added: 0 }
  const [, c, s] = csMatch
  const questions = await parseQuestions(pdfPath)
  const answers = await getAnswerKey(gap.examCode, c, s, gap.paperCount, gap.examId)
  if (!answers) return { status: 'NO_ANS', added: 0 }

  const filePath = path.join(BACKEND, gap.jsonFile)
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const arr = data.questions || data
  const maxId = arr.reduce((m, q) => Math.max(m, typeof q.id === 'number' ? q.id : parseInt(String(q.id).replace(/\D/g, '')) || 0), 0)
  let nextId = maxId + 1
  const existing = new Set(arr.filter(q => q.exam_code === gap.examCode && q.subject === gap.subject).map(q => q.number))
  let added = 0
  for (const num of gap.missing) {
    if (existing.has(num)) continue
    const found = questions.find(q => q.number === num)
    if (!found || !found.options || Object.keys(found.options).length !== 4) continue
    if (Object.values(found.options).some(v => !v || v.length < 2)) continue
    const ans = answers[num - 1]
    if (!ans || ans === '#') continue
    existing.add(num)
    arr.push({
      id: nextId++,
      roc_year: gap.rocYear, session: gap.session, exam_code: gap.examCode,
      subject: gap.subject, subject_tag: gap.subject_tag, subject_name: gap.subject,
      stage_id: 0, number: num, question: found.question, options: found.options,
      answer: ans, explanation: '',
    })
    added++
  }
  if (added > 0) {
    arr.sort((a, b) => {
      if (a.exam_code !== b.exam_code) return a.exam_code.localeCompare(b.exam_code)
      if (a.subject !== b.subject) return a.subject.localeCompare(b.subject)
      return (a.number || 0) - (b.number || 0)
    })
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
  }
  return { status: 'OK', added, total: gap.missing.length }
}

async function main() {
  const gaps = audit()
  console.log(`Found ${gaps.length} papers with small gaps. Total missing: ${gaps.reduce((s, g) => s + g.missing.length, 0)}\n`)
  let totalAdded = 0
  const stats = { OK: 0, NO_PDF: 0, NO_CS: 0, NO_ANS: 0 }
  for (const g of gaps) {
    const r = await fillGap(g)
    stats[r.status]++
    if (r.added > 0) {
      console.log(`  ✓ ${g.examId} ${g.examCode} ${g.subject}: +${r.added}/${r.total}`)
      totalAdded += r.added
    } else if (r.status !== 'OK') {
      console.log(`  ✗ ${g.examId} ${g.examCode} ${g.subject}: ${r.status}`)
    }
  }
  console.log(`\n=== Summary ===`)
  console.log(`Total questions added: ${totalAdded}`)
  console.log(`OK: ${stats.OK}, NO_PDF: ${stats.NO_PDF}, NO_CS: ${stats.NO_CS}, NO_ANS: ${stats.NO_ANS}`)
}

main().catch(e => { console.error(e); process.exit(1) })
