#!/usr/bin/env node
// Fix 10 nursing + 1 tcm2 incomplete entries using correct c-codes.
// Discovered: fill-gaps-vision script had wrong c-code (c=101) for 106030-108110
// nursing, but correct is c=106. Column parser works fine with right URL.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')
const { parseColumnAware } = require('./lib/moex-column-parser')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false, timeout: 25000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*',
                 Referer: 'https://wwwq.moex.gov.tw/' } }, res => {
      if (res.statusCode !== 200) {
        res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800)
        return reject(new Error('HTTP ' + res.statusCode))
      }
      const cs = []; res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    }).on('error', e => retries > 0 ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800) : reject(e))
  })
}

function parseAnswers(text) {
  const answers = {}
  const fw = /答案\s*([ＡＢＣＤ#＃]+)/g
  let m, n = 1
  while ((m = fw.exec(text)) !== null) {
    for (const ch of m[1]) {
      if (ch === '#' || ch === '＃') { n++; continue }
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) answers[n++] = k
    }
  }
  return answers
}

// New-format (108+) answer PDFs use a grid layout. Extract by (x,y) proximity
// between each "第N題" label and the A-D letter directly below it.
async function parseAnswersPdfjs(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise
  const answers = {}
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    const items = content.items
      .map(it => ({ s: it.str, x: it.transform[4], y: it.transform[5] }))
      .filter(i => i.s && i.s.trim())
    const labels = items.filter(i => /^第\d+題/.test(i.s))
    const letters = items.filter(i => /^[A-D]$/.test(i.s.trim()))
    for (const lb of labels) {
      const n = parseInt(lb.s.match(/\d+/)[0])
      if (answers[n]) continue
      const cand = letters.filter(lt => Math.abs(lt.x - lb.x) < 20 && lt.y < lb.y && lt.y > lb.y - 40)
      cand.sort((a, b) => b.y - a.y)
      if (cand[0]) answers[n] = cand[0].s.trim()
    }
  }
  return answers
}

// Fallback: extract one question from raw pdf-parse text by question number.
// Handles the "N 題幹\n選項1 選項2 選項3 選項4\nN+1 ..." layout seen in nursing PDFs.
function extractOneFromText(text, n) {
  const re = new RegExp(`\\n${n}\\s+([\\s\\S]*?)\\n${n + 1}\\s`, '')
  const m = text.match(re)
  if (!m) return null
  const body = m[1]
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean)
  // Strategy A: options on single line with 2+ space separators
  for (let i = 0; i < lines.length; i++) {
    const segs = lines[i].split(/\s{2,}/).filter(Boolean)
    if (segs.length >= 4 && lines.slice(0, i).length > 0) {
      const question = lines.slice(0, i).join(' ').replace(/\s+/g, ' ').trim()
      return { question, options: { A: segs[0], B: segs[1], C: segs[2], D: segs[3] } }
    }
  }
  // Strategy B: options one-per-line as last 4 lines, question is everything before
  if (lines.length >= 5) {
    const opts = lines.slice(-4)
    const qLines = lines.slice(0, -4)
    const question = qLines.join(' ').replace(/\s+/g, ' ').trim()
    return { question, options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] } }
  }
  return null
}

const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s
const sleep = ms => new Promise(r => setTimeout(r, ms))

const TARGETS = [
  { examFile: 'questions-nursing.json', year: '106', session: '第一次', code: '106030', c: '106', s: '0502',
    subject: '基本護理學與護理行政', tag: 'basic_nursing', nums: [6] },
  { examFile: 'questions-nursing.json', year: '107', session: '第一次', code: '107030', c: '106', s: '0502',
    subject: '基本護理學與護理行政', tag: 'basic_nursing', nums: [4, 46] },
  { examFile: 'questions-nursing.json', year: '108', session: '第一次', code: '108020', c: '106', s: '0501',
    subject: '基礎醫學', tag: 'basic_medicine', nums: [60, 61, 66, 72] },
  { examFile: 'questions-nursing.json', year: '108', session: '第一次', code: '108020', c: '106', s: '0502',
    subject: '基本護理學與護理行政', tag: 'basic_nursing', nums: [26] },
  { examFile: 'questions-nursing.json', year: '108', session: '第二次', code: '108110', c: '106', s: '0502',
    subject: '基本護理學與護理行政', tag: 'basic_nursing', nums: [49, 68] },
  { examFile: 'questions-tcm2.json', year: '108', session: '第二次', code: '108110', c: '102', s: '0103',
    subject: '中醫臨床醫學(一)', tag: 'tcm_clinical_1', nums: [33] },
]

async function main() {
  const byFile = new Map()
  for (const t of TARGETS) {
    const url = `${BASE}?t=Q&code=${t.code}&c=${t.c}&s=${t.s}&q=1`
    const aurl = `${BASE}?t=S&code=${t.code}&c=${t.c}&s=${t.s}&q=1`
    console.log(`\n── ${t.examFile} ${t.code} ${t.subject} (c=${t.c} s=${t.s}) ──`)
    const qBuf = await fetchPdf(url)
    let aBuf = null
    try { aBuf = await fetchPdf(aurl) } catch (e) { console.log(`  ⚠ answer fetch: ${e.message}`) }
    const parsed = await parseColumnAware(qBuf)
    const { text: qText } = await pdfParse(qBuf)
    const aText = aBuf ? (await pdfParse(aBuf)).text : ''
    let answers = parseAnswers(aText)
    if (aBuf && Object.keys(answers).length < 20) {
      try { answers = await parseAnswersPdfjs(aBuf) }
      catch (e) { console.log(`  ⚠ pdfjs answer parse: ${e.message}`) }
    }

    for (const n of t.nums) {
      let pq = parsed[n]
      if (!pq || !pq.question || !['A','B','C','D'].every(k=>(pq.options?.[k]||'').length>=1)) {
        console.log(`  ⚠ Q${n}: column parser incomplete, trying text fallback`)
        pq = extractOneFromText(qText, n)
      }
      const a = answers[n]
      if (!pq || !pq.question || !a || !/^[A-D]$/.test(a) ||
          !['A','B','C','D'].every(k=>(pq.options?.[k]||'').length>=1)) {
        console.log(`  ✗ Q${n}: unrecoverable`)
        continue
      }
      if (!byFile.has(t.examFile)) byFile.set(t.examFile, [])
      byFile.get(t.examFile).push({ t, n, pq, a })
      console.log(`  ✓ Q${n}: ${pq.question.slice(0, 40)} [${a}]`)
    }
    await sleep(500)
  }

  for (const [fname, items] of byFile) {
    const fp = path.join(__dirname, '..', fname)
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    let fixed = 0
    for (const { t, n, pq, a } of items) {
      const idx = data.questions.findIndex(x =>
        x.exam_code === t.code && x.subject === t.subject && x.number === n)
      if (idx < 0) {
        const nextId = Math.max(...data.questions.map(q => q.id || 0)) + 1
        data.questions.push({
          id: nextId, roc_year: t.year, session: t.session, exam_code: t.code,
          subject: t.subject, subject_tag: t.tag, subject_name: t.subject,
          stage_id: 0, number: n,
          question: stripPUA(pq.question),
          options: Object.fromEntries(['A','B','C','D'].map(k=>[k, stripPUA(pq.options[k])])),
          answer: a, explanation: '',
        })
        console.log(`  + added ${fname} ${t.code} ${t.subject} Q${n}`)
        fixed++; continue
      }
      const rec = {
        ...data.questions[idx],
        question: stripPUA(pq.question),
        options: Object.fromEntries(['A','B','C','D'].map(k=>[k, stripPUA(pq.options[k])])),
        answer: a,
      }
      delete rec.incomplete
      delete rec.gap_reason
      data.questions[idx] = rec
      fixed++
    }
    data.total = data.questions.length
    const tmp = fp + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, fp)
    console.log(`\n✅ ${fname}: ${fixed} fixed`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
