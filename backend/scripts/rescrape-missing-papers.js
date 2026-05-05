#!/usr/bin/env node
/**
 * Re-scrape 9 missing papers whose PDFs were cached but never inserted into
 * questions JSON (audit-missing-papers.js identified them).
 *
 * Strategy: simple text-based parser for the "1.question\nA.opt\nB.opt..." format
 * common to MoEX 100-104 era PDFs. Answer parsing reuses the column-aware lib.
 */

require('dotenv/config')
const fs   = require('fs')
const path = require('path')
const https = require('https')
const lib  = require('./lib/moex-column-parser')

const BACKEND   = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const TARGETS = [
  // dental2 卷四 (paper 4) for 6 missing year-sessions
  { exam: 'dental2', file: 'questions-dental2.json',
    code: '100020', c: '302', s: '66', year: '100', session: '第一次',
    subject: '卷四', subject_tag: 'paper4', subject_name: '牙醫學(六)',
    paperId: 'paper4' },
  { exam: 'dental2', file: 'questions-dental2.json',
    code: '101100', c: '302', s: '66', year: '101', session: '第二次',
    subject: '卷四', subject_tag: 'paper4', subject_name: '牙醫學(六)',
    paperId: 'paper4' },
  { exam: 'dental2', file: 'questions-dental2.json',
    code: '102020', c: '302', s: '66', year: '102', session: '第一次',
    subject: '卷四', subject_tag: 'paper4', subject_name: '牙醫學(六)',
    paperId: 'paper4' },
  { exam: 'dental2', file: 'questions-dental2.json',
    code: '102100', c: '302', s: '66', year: '102', session: '第二次',
    subject: '卷四', subject_tag: 'paper4', subject_name: '牙醫學(六)',
    paperId: 'paper4' },
  { exam: 'dental2', file: 'questions-dental2.json',
    code: '103020', c: '302', s: '66', year: '103', session: '第一次',
    subject: '卷四', subject_tag: 'paper4', subject_name: '牙醫學(六)',
    paperId: 'paper4' },
  { exam: 'dental2', file: 'questions-dental2.json',
    code: '103090', c: '302', s: '66', year: '103', session: '第二次',
    subject: '卷四', subject_tag: 'paper4', subject_name: '牙醫學(六)',
    paperId: 'paper4' },

  // nursing 基礎醫學 (paper 1) for 3 missing year-sessions
  { exam: 'nursing', file: 'questions-nursing.json',
    code: '103030', c: '109', s: '0107', year: '103', session: '第一次',
    subject: '基礎醫學', subject_tag: 'paper1', subject_name: '基礎醫學',
    paperId: 'paper1' },
  { exam: 'nursing', file: 'questions-nursing.json',
    code: '103100', c: '109', s: '0107', year: '103', session: '第二次',
    subject: '基礎醫學', subject_tag: 'paper1', subject_name: '基礎醫學',
    paperId: 'paper1' },
  { exam: 'nursing', file: 'questions-nursing.json',
    code: '104030', c: '109', s: '0107', year: '104', session: '第一次',
    subject: '基礎醫學', subject_tag: 'paper1', subject_name: '基礎醫學',
    paperId: 'paper1' },

  // medlab 100-2 臨床生理學與病理學 (had only 30/80 — re-scrape)
  { exam: 'medlab', file: 'questions-medlab.json',
    code: '100140', c: '104', s: '0107', year: '100', session: '第二次',
    subject: '臨床生理學與病理學', subject_tag: 'paper1', subject_name: '臨床生理學與病理學',
    paperId: 'paper1' },
]

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

function get(url) {
  return new Promise((res, rej) => {
    const agent = new https.Agent({ rejectUnauthorized: false })
    https.get(url, { agent }, r => {
      if (r.statusCode === 302) return rej(new Error('redirect ' + (r.headers.location || '')))
      if (r.statusCode !== 200) return rej(new Error('HTTP ' + r.statusCode))
      const chunks = []
      r.on('data', c => chunks.push(c))
      r.on('end', () => res(Buffer.concat(chunks)))
    }).on('error', rej)
  })
}

async function loadOrFetchQuestionPdf(t) {
  const cacheFile = path.join(PDF_CACHE, `${t.exam}_${t.code}_c${t.c}_s${t.s}.pdf`)
  if (fs.existsSync(cacheFile)) {
    const buf = fs.readFileSync(cacheFile)
    if (buf.length > 1000) return buf
  }
  const url = `${BASE}?t=Q&code=${t.code}&c=${t.c}&s=${t.s}&q=1`
  console.log('  download', url)
  const buf = await get(url)
  fs.writeFileSync(cacheFile, buf)
  return buf
}

async function loadOrFetchAnswerPdf(t) {
  const cacheFile = path.join(PDF_CACHE, `A_${t.exam}_${t.code}_c${t.c}_s${t.s}.pdf`)
  if (fs.existsSync(cacheFile)) {
    const buf = fs.readFileSync(cacheFile)
    if (buf.length > 1000) return buf
  }
  // try t=S first, then t=A as fallback (100-era often only has t=A)
  for (const t_param of ['S', 'A']) {
    try {
      const url = `${BASE}?t=${t_param}&code=${t.code}&c=${t.c}&s=${t.s}&q=1`
      const buf = await get(url)
      fs.writeFileSync(cacheFile, buf)
      return buf
    } catch (e) {
      // try next
    }
  }
  return null
}

// Parser for two formats:
//  (a) "N.question\nA.opt\nB.opt\nC.opt\nD.opt" — modern (106+)
//  (b) "N\nquestion\nopt1\nopt2\nopt3\nopt4"     — old (100-104, no ABCD labels)
async function parseQuestionsFromText(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n = doc.countPages()
  let fullText = ''
  for (let i = 0; i < n; i++) {
    fullText += doc.loadPage(i).toStructuredText('preserve-whitespace').asText() + '\n'
  }

  const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean)

  // Skip header noise lines (代號, 頁次, 等別, 類科, 科目, 考試時間, ※, 本試題, 禁止)
  const isHeader = ln => /^(代號|頁次|等\s*別|類\s*科|科\s*目|考試時間|本試題|本科目|本科共|禁止|座號|※|請考生|公告)/u.test(ln)

  // Decide format by presence of "A.opt" lines anywhere in early text
  const hasABCDLabels = lines.slice(0, 100).some(l => /^[A-D][.、．]\s*\S/.test(l))

  const questions = []
  let cur = null

  if (hasABCDLabels) {
    // Format (a)
    for (const line of lines) {
      if (isHeader(line)) continue
      const qMatch = line.match(/^(\d{1,3})[.、．]\s*(.+)/)
      if (qMatch) {
        const n = parseInt(qMatch[1])
        const rest = qMatch[2]
        if (n >= 1 && n <= 100 && /[一-鿿]/.test(rest) && !/^[A-D]/.test(rest)) {
          if (cur) questions.push(cur)
          cur = { number: n, question: rest, options: { A:'', B:'', C:'', D:'' } }
          continue
        }
      }
      const optMatch = line.match(/^([A-D])[.、．]\s*(.+)/)
      if (optMatch && cur) {
        cur.options[optMatch[1]] = optMatch[2]
        continue
      }
      if (cur) {
        const lastOptKey = ['D','C','B','A'].find(k => cur.options[k])
        if (lastOptKey) cur.options[lastOptKey] += ' ' + line
        else cur.question += ' ' + line
      }
    }
  } else {
    // Format (b) — anchor is bare "N" line, followed by question line, then 4 options
    let mode = 'wait'  // wait | question | optA | optB | optC | optD
    let optsCollected = 0
    for (const line of lines) {
      if (isHeader(line)) continue
      const numOnly = line.match(/^(\d{1,3})$/)
      if (numOnly) {
        const n = parseInt(numOnly[1])
        if (n >= 1 && n <= 100) {
          if (cur && optsCollected >= 3) questions.push(cur)
          cur = { number: n, question: '', options: { A:'', B:'', C:'', D:'' } }
          mode = 'question'
          optsCollected = 0
          continue
        }
      }
      if (!cur) continue
      // Inline option label form: "A.opt" can occasionally appear in old PDFs
      const labeledOpt = line.match(/^([A-D])[.、．]\s*(.+)/)
      if (labeledOpt) {
        cur.options[labeledOpt[1]] = labeledOpt[2]
        if (labeledOpt[1] === 'D') optsCollected = 4
        else optsCollected = Math.max(optsCollected, ['A','B','C','D'].indexOf(labeledOpt[1]) + 1)
        mode = labeledOpt[1] === 'D' ? 'wait' : 'after_label'
        continue
      }
      if (mode === 'question') {
        cur.question = line
        mode = 'optA'
        continue
      }
      const slot = ['A','B','C','D'][optsCollected]
      if (slot && cur.options[slot] === '') {
        cur.options[slot] = line
        optsCollected++
        if (optsCollected === 4) mode = 'wait'
        continue
      }
      // Continuation lines (long question or option wraps)
      const lastOptKey = ['D','C','B','A'].find(k => cur.options[k])
      if (lastOptKey) cur.options[lastOptKey] += ' ' + line
      else if (cur.question) cur.question += ' ' + line
    }
    if (cur && optsCollected >= 3) questions.push(cur)
  }
  return questions
}

async function processTarget(t, idx, total) {
  console.log(`\n[${idx+1}/${total}] ${t.exam} ${t.year} ${t.session} ${t.subject}`)
  const qPdf = await loadOrFetchQuestionPdf(t)
  const aPdf = await loadOrFetchAnswerPdf(t)

  let questions = await parseQuestionsFromText(qPdf)
  // Filter out garbage: must have Chinese question + at least 3 non-empty options
  questions = questions.filter(q =>
    /[一-鿿]/.test(q.question) &&
    Object.values(q.options).filter(v => v && v.length > 0).length >= 3 &&
    q.number >= 1 && q.number <= 100
  )
  console.log(`  parsed ${questions.length} questions`)

  // Parse answers — try column-aware first, then text-based, then a manual
  // halfwidth/fullwidth scanner for "答案ABCD..." in case both lib parsers fail.
  // Use whichever parser yields the MOST answers (each parser handles different
  // PDF layouts; require ≥40 to consider "good").
  let answers = {}
  if (aPdf) {
    try {
      const r = await lib.parseAnswersColumnAware(aPdf)
      if (r && Object.keys(r).length > Object.keys(answers).length) answers = r
    } catch {}
    try {
      const r = lib.parseAnswersText(aPdf)
      if (r && Object.keys(r).length > Object.keys(answers).length) answers = r
    } catch {}
    if (Object.keys(answers).length < 40) {
      // Manual scan: extract continuous letter runs after "答案"
      try {
        const mupdf = await import('mupdf')
        const doc = mupdf.Document.openDocument(new Uint8Array(aPdf), 'application/pdf')
        let txt = ''
        for (let i = 0; i < doc.countPages(); i++) {
          txt += doc.loadPage(i).toStructuredText('preserve-whitespace').asText() + '\n'
        }
        const blocks = [...txt.matchAll(/答案\s*([ABCDＡＢＣＤ\s#＃]+)/g)]
        const manual = {}
        let qNum = 1
        for (const m of blocks) {
          const letters = m[1].replace(/\s+/g, '').replace(/[ＡＢＣＤ]/g, c => ({ Ａ:'A', Ｂ:'B', Ｃ:'C', Ｄ:'D' }[c])).replace(/[#＃]/g, '')
          for (const ch of letters) {
            if (/[A-D]/.test(ch)) { manual[qNum] = ch; qNum++; if (qNum > 100) break }
          }
          if (qNum > 100) break
        }
        if (Object.keys(manual).length > Object.keys(answers).length) answers = manual
      } catch {}
    }
    console.log(`  parsed ${Object.keys(answers).length} answers`)
  }

  // Apply answers
  for (const q of questions) {
    if (answers[q.number]) q.answer = answers[q.number]
  }

  // Build full question objects matching JSON schema
  const built = questions
    .filter(q => q.answer)  // only keep ones with answers
    .map(q => ({
      id:           parseInt(t.code) * 1000 + q.number, // pseudo unique
      roc_year:     t.year,
      session:      t.session,
      exam_code:    t.code,
      subject:      t.subject,
      subject_tag:  t.subject_tag,
      subject_name: t.subject_name,
      paper_id:     t.paperId,
      stage_id:     0,
      number:       q.number,
      question:     q.question,
      options:      q.options,
      answer:       q.answer,
      explanation:  '',
    }))

  console.log(`  built ${built.length} complete questions`)

  // Merge into JSON
  const filePath = path.join(BACKEND, t.file)
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const arr = raw.questions || raw

  // Skip duplicates: questions with same (exam_code, subject, number) already exist
  const existingKeys = new Set(arr
    .filter(q => q.exam_code === t.code && q.subject === t.subject)
    .map(q => `${q.exam_code}|${q.subject}|${q.number}`))

  const toAdd = built.filter(q => !existingKeys.has(`${q.exam_code}|${q.subject}|${q.number}`))
  arr.push(...toAdd)

  if (toAdd.length > 0) {
    const toSave = raw.questions ? raw : arr
    fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2))
    console.log(`  💾 ${t.file} (+${toAdd.length} questions)`)
  } else {
    console.log(`  no new questions added (all duplicates or no answers)`)
  }
  return toAdd.length
}

async function main() {
  let total = 0
  for (let i = 0; i < TARGETS.length; i++) {
    try {
      total += await processTarget(TARGETS[i], i, TARGETS.length)
    } catch (e) {
      console.log(`  ✗ ${e.message}`)
    }
  }
  console.log(`\n總計: ${total} questions added`)
}

main().catch(e => { console.error(e); process.exit(1) })
