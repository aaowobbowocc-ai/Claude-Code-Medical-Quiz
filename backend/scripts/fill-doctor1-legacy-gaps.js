#!/usr/bin/env node
// Text-based fallback for the 6 remaining doctor1 gaps in 100-103 years
// whose PDFs use the legacy 2-column-no-ABCD format that the column parser
// couldn't extract. We use pdf-parse raw text + locate anchor + slice to next
// anchor, then split into question + 4 options by empty lines / 2-col layout.

const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')
const { parseAnswersText, parseAnswersColumnAware } = require('./lib/moex-column-parser')

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const QFILE = path.join(__dirname, '..', 'questions.json')

const TARGETS = [
  { yr:'100', ses:'第一次', subj:'醫學(二)', code:'100030', c:'101', s:'0102', miss:[28] },
  { yr:'101', ses:'第一次', subj:'醫學(二)', code:'101030', c:'101', s:'0102', miss:[32] },
  { yr:'101', ses:'第二次', subj:'醫學(二)', code:'101110', c:'101', s:'0102', miss:[75,98] },
  { yr:'102', ses:'第二次', subj:'醫學(一)', code:'102110', c:'101', s:'0101', miss:[87] },
  { yr:'103', ses:'第二次', subj:'醫學(一)', code:'103100', c:'101', s:'0101', miss:[70] },
]

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode))
      const bufs = []
      res.on('data', b => bufs.push(b))
      res.on('end', () => resolve(Buffer.concat(bufs)))
    }).on('error', reject)
  })
}

const buildUrl = (t, ty) =>
  `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=${ty}&code=${t.code}&c=${t.c}&s=${t.s}&q=1`

// Extract Q{num} block from raw pdf-parse text for 100-105 years
function extractFromText(text, num) {
  // Anchor pattern: newline + num alone on a line
  const anchor = new RegExp(`\\n\\s*${num}\\s*\\n`)
  const nextAnchor = new RegExp(`\\n\\s*${num + 1}\\s*\\n`)
  const m = text.match(anchor)
  if (!m) return null
  const start = m.index + m[0].length
  const restFromStart = text.slice(start)
  const m2 = restFromStart.match(nextAnchor)
  if (!m2) return null
  const block = restFromStart.slice(0, m2.index).trim()

  // The block has:
  //   line1..N: question text (may span multiple lines)
  //   line N+1: opt1  opt2  (row 1 of 2-col)
  //   line N+2: opt3  opt4  (row 2 of 2-col)
  //
  // Strategy: split on blank-line boundaries. Last "paragraph" contains options.
  const paragraphs = block.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
  if (paragraphs.length < 2) return null

  const lastParagraphs = paragraphs.slice(-2)  // last 2 paragraphs for 2 option rows
  const questionParas = paragraphs.slice(0, -2).join('')
  let question = questionParas.replace(/\s+/g, '')

  // But question might be in a single paragraph, options the next one (bundled)
  // Try alternate: if last paragraph has 4 components separable by wide space, use it alone
  const lastOne = paragraphs[paragraphs.length - 1]
  const optCandidates = lastOne.split(/\s{2,}|\n/).map(s => s.trim()).filter(Boolean)
  if (optCandidates.length === 4) {
    const q = paragraphs.slice(0, -1).join('').replace(/\s+/g, '')
    return { question: q, options: { A: optCandidates[0], B: optCandidates[1], C: optCandidates[2], D: optCandidates[3] } }
  }

  // Else use last-2-paragraph scheme
  if (lastParagraphs.length === 2) {
    const row1 = lastParagraphs[0].split(/\s{2,}|\n/).map(s => s.trim()).filter(Boolean)
    const row2 = lastParagraphs[1].split(/\s{2,}|\n/).map(s => s.trim()).filter(Boolean)
    if (row1.length === 2 && row2.length === 2) {
      return { question, options: { A: row1[0], B: row1[1], C: row2[0], D: row2[1] } }
    }
  }
  return null
}

async function main() {
  const data = JSON.parse(fs.readFileSync(QFILE, 'utf8'))
  const arr = Array.isArray(data) ? data : data.questions

  const adds = []
  const tried = []

  for (const t of TARGETS) {
    console.log(`\n-- ${t.yr}-${t.ses} ${t.subj} ${t.code} miss=${t.miss.join(',')} --`)
    let qBuf, aBuf
    try {
      qBuf = await fetch(buildUrl(t, 'Q'))
      aBuf = await fetch(buildUrl(t, 'S'))
    } catch (e) { console.log('  fetch:', e.message); continue }
    const qText = (await pdfParse(qBuf)).text
    let ans = {}
    try {
      ans = await parseAnswersColumnAware(aBuf)
      if (Object.keys(ans).length === 0) throw new Error('empty')
    } catch {
      ans = parseAnswersText((await pdfParse(aBuf)).text)
    }

    for (const n of t.miss) {
      const extracted = extractFromText(qText, n)
      const answer = ans[n]
      if (!extracted || !answer) {
        console.log(`  Q${n} → FAILED (extract=${!!extracted}, answer=${!!answer})`)
        tried.push({ t, n, extracted, answer })
        continue
      }
      const id = `${t.code}_${t.s}_${n}`
      const subjDefault = t.subj === '醫學(一)' ? 'anatomy' : 'pathology'
      const entry = {
        id, roc_year: t.yr, session: t.ses, exam_code: t.code,
        subject: t.subj, subject_tag: subjDefault, subject_name: t.subj,
        stage_id: 0, number: n,
        question: extracted.question,
        options: extracted.options,
        answer, explanation: '',
      }
      adds.push(entry)
      console.log(`  Q${n} → ${entry.question.substring(0, 50)}... ans=${answer}`)
      console.log(`    A: ${entry.options.A.substring(0, 50)}`)
      console.log(`    B: ${entry.options.B.substring(0, 50)}`)
      console.log(`    C: ${entry.options.C.substring(0, 50)}`)
      console.log(`    D: ${entry.options.D.substring(0, 50)}`)
    }
  }

  console.log(`\n=== Added ${adds.length} | Failed ${tried.length} ===`)
  if (process.argv.includes('--dry-run')) { console.log('(dry-run, no write)'); return }
  if (adds.length === 0) return
  const out = Array.isArray(data) ? [...arr, ...adds] : { ...data, questions: [...arr, ...adds] }
  const tmp = QFILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2))
  fs.renameSync(tmp, QFILE)
  console.log('wrote', QFILE)
}

main().catch(e => { console.error(e); process.exit(1) })
