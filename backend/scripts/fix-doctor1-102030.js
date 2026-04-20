#!/usr/bin/env node
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')
const { parseColumnAware } = require('./lib/moex-column-parser.js')

const UA = 'Mozilla/5.0 Chrome/131.0.0.0'
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
    for (const p of r.parts) { if (n > 100) break; ans[n++] = p.str }
  }
  return ans
}

const PAPERS = [
  { s: '0101', subject: '醫學(一)', tag: 'medicine_1', stage_id: 1 },
  { s: '0102', subject: '醫學(二)', tag: 'medicine_2', stage_id: 2 },
]

async function main() {
  const fp = path.join(__dirname, '..', 'questions.json')
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  let maxId = data.questions.reduce((m, q) => {
    const n = typeof q.id === 'number' ? q.id : parseInt(String(q.id).split('_')[0], 10)
    return isNaN(n) ? m : Math.max(m, n)
  }, 0)
  let total = 0
  for (const p of PAPERS) {
    const existNums = new Set(data.questions
      .filter(q => q.exam_code === '102030' && q.subject === p.subject).map(q => q.number))
    const miss = []
    for (let i=1;i<=100;i++) if (!existNums.has(i)) miss.push(i)
    if (!miss.length) { console.log(`${p.subject}: 已完整`); continue }
    console.log(`${p.subject}: 缺 ${miss.join(',')}`)
    const qBuf = await fetchPdf(`${BASE}?t=Q&code=102030&c=101&s=${p.s}&q=1`)
    const rawText = (await pdfParse(qBuf).catch(()=>({text:''}))).text.slice(0,400).normalize('NFKC')
    if (!rawText.includes('醫師')) { console.log('  ✗ 非醫師'); continue }
    await sleep(300)
    const aBuf = await fetchPdf(`${BASE}?t=S&code=102030&c=101&s=${p.s}&q=1`)
    const parsed = await parseColumnAware(qBuf)
    const answers = await parseAnswersPdfJs(aBuf)
    console.log(`  parsed ${Object.keys(parsed).length}, answers ${Object.keys(answers).length}`)
    for (const n of miss) {
      const pq = parsed[n]; const ans = answers[n]
      if (!pq || !ans) { console.log(`  ✗ Q${n}: parsed=${!!pq} ans=${ans||'-'}`); continue }
      const opts = ['A','B','C','D'].map(k => stripPUA(pq.options[k]||''))
      if (!opts.every(o => o.length >= 1)) { console.log(`  ✗ Q${n}: 選項不全`); continue }
      maxId++
      data.questions.push({
        id: maxId,
        roc_year: '102', session: '第一次', exam_code: '102030',
        subject: p.subject, subject_tag: p.tag, subject_name: p.subject,
        stage_id: p.stage_id, number: n,
        question: stripPUA(pq.question),
        options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] },
        answer: ans, explanation: '',
      })
      total++
      console.log(`  +Q${n} (${ans})`)
    }
    await sleep(300)
  }
  data.total = data.questions.length
  if (data.metadata) data.metadata.last_updated = new Date().toISOString()
  fs.writeFileSync(fp + '.tmp', JSON.stringify(data, null, 2))
  fs.renameSync(fp + '.tmp', fp)
  console.log(`\n✅ doctor1 102030: added ${total} (total ${data.total})`)
}
main().catch(e => { console.error(e); process.exit(1) })
