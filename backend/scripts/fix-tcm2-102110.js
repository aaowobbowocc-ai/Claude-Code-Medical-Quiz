#!/usr/bin/env node
// Fill missing tcm2 102110 questions (c=105 s=0203-0206).
// Existing: 臨床(一)46, (二)57, (三)18, (四)33 — merges only missing numbers.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')
const { parseColumnAware } = require('./lib/moex-column-parser.js')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false, timeout: 25000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*', Referer: 'https://wwwq.moex.gov.tw/' } }, res => {
      if (res.statusCode !== 200) { res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800)
        return reject(new Error('HTTP ' + res.statusCode)) }
      const cs = []; res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    }).on('error', e => retries > 0 ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800) : reject(e))
  })
}

async function parseAnswersPdfJs(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise
  const LETTERS = new Set(['Ａ','Ｂ','Ｃ','Ｄ','A','B','C','D'])
  const toHalf = c => ({ 'Ａ':'A','Ｂ':'B','Ｃ':'C','Ｄ':'D' })[c] || c
  const items = []
  for (let pi = 1; pi <= doc.numPages; pi++) {
    const page = await doc.getPage(pi)
    const content = await page.getTextContent()
    for (const it of content.items) {
      const s = it.str.trim()
      if (s.length !== 1 || !LETTERS.has(s)) continue
      items.push({ str: toHalf(s), page: pi, x: it.transform[4], y: it.transform[5] })
    }
  }
  items.sort((a,b) => a.page - b.page || b.y - a.y || a.x - b.x)
  const rows = []
  for (const it of items) {
    const last = rows[rows.length-1]
    if (last && last.page === it.page && Math.abs(last.y - it.y) < 3) last.parts.push(it)
    else rows.push({ page: it.page, y: it.y, parts: [it] })
  }
  const ans = {}
  let n = 1
  for (const r of rows.filter(r => r.parts.length >= 10)) {
    r.parts.sort((a,b) => a.x - b.x)
    for (const p of r.parts) { if (n > 80) break; ans[n++] = p.str }
  }
  return ans
}

const PAPERS = [
  { s: '0203', subject: '中醫臨床醫學(一)', tag: 'tcm_clinical_1' },
  { s: '0204', subject: '中醫臨床醫學(二)', tag: 'tcm_clinical_2' },
  { s: '0205', subject: '中醫臨床醫學(三)', tag: 'tcm_clinical_3' },
  { s: '0206', subject: '中醫臨床醫學(四)', tag: 'tcm_clinical_4' },
]

async function main() {
  const fp = path.join(__dirname, '..', 'questions-tcm2.json')
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  let maxId = data.questions.reduce((m, q) => {
    const n = typeof q.id === 'number' ? q.id : parseInt(String(q.id).split('_')[0], 10)
    return isNaN(n) ? m : Math.max(m, n)
  }, 0)
  let added = 0
  for (const p of PAPERS) {
    // Existing numbers for this subject
    const existNums = new Set(data.questions
      .filter(q => q.exam_code === '102110' && q.subject === p.subject)
      .map(q => q.number))
    const qUrl = `${BASE}?t=Q&code=102110&c=105&s=${p.s}&q=1`
    const aUrl = `${BASE}?t=S&code=102110&c=105&s=${p.s}&q=1`
    const qBuf = await fetchPdf(qUrl)
    await sleep(300)
    const aBuf = await fetchPdf(aUrl)
    const parsed = await parseColumnAware(qBuf)
    const answers = await parseAnswersPdfJs(aBuf)
    const good = Object.values(parsed).filter(q => ['A','B','C','D'].every(k => (q.options[k]||'').length >= 1)).length
    console.log(`${p.subject}: parsed ${good}/80, answers ${Object.keys(answers).length}, existing ${existNums.size}`)
    let localAdd = 0
    for (let n = 1; n <= 80; n++) {
      if (existNums.has(n)) continue
      const pq = parsed[n]; const ans = answers[n]
      if (!pq || !ans) continue
      const opts = ['A','B','C','D'].map(k => stripPUA(pq.options[k]||''))
      if (!opts.every(o => o.length >= 1)) continue
      maxId++
      data.questions.push({
        id: maxId,
        roc_year: '102', session: '第二次', exam_code: '102110',
        subject: p.subject, subject_tag: p.tag, subject_name: p.subject,
        stage_id: 0, number: n,
        question: stripPUA(pq.question),
        options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] },
        answer: ans, explanation: '',
      })
      added++; localAdd++
    }
    console.log(`  +${localAdd}`)
    await sleep(300)
  }
  data.total = data.questions.length
  if (data.metadata) data.metadata.last_updated = new Date().toISOString()
  fs.writeFileSync(fp + '.tmp', JSON.stringify(data, null, 2))
  fs.renameSync(fp + '.tmp', fp)
  console.log(`\n✅ tcm2 102110: added ${added} questions (total now ${data.total})`)
}
main().catch(e => { console.error(e); process.exit(1) })
