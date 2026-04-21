#!/usr/bin/env node
// Fill customs 法學知識 gaps for 111050 (s=0310) and 112050 (s=0308).

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

async function parseAnswersPdfjs(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise
  const answers = {}
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    const items = content.items.map(it => ({ s: it.str, x: it.transform[4], y: it.transform[5] })).filter(i => i.s && i.s.trim())
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

function parseAnswersText(text) {
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

const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s

const TARGETS = [
  { code: '111050', c: '101', s: '0310', year: '111', session: '第一次',
    subject: '法學知識', tag: 'law_knowledge',
    nums: [5, 9, 10, 39, 40, 43] },
  { code: '112050', c: '101', s: '0308', year: '112', session: '第一次',
    subject: '法學知識', tag: 'law_knowledge',
    nums: [20, 27, 33, 35, 37, 47] },
]

async function main() {
  const file = path.join(__dirname, '..', 'questions-customs.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
  let nextId = Math.max(...data.questions.map(q => q.id || 0)) + 1
  let added = 0, replaced = 0, skipped = 0
  for (const t of TARGETS) {
    const qUrl = `${BASE}?t=Q&code=${t.code}&c=${t.c}&s=${t.s}&q=1`
    const aUrl = `${BASE}?t=S&code=${t.code}&c=${t.c}&s=${t.s}&q=1`
    console.log(`\n── customs ${t.code} ${t.subject} (c=${t.c} s=${t.s}) ──`)
    const qBuf = await fetchPdf(qUrl)
    let aBuf = null
    try { aBuf = await fetchPdf(aUrl) } catch (e) { console.log(`  ⚠ answer: ${e.message}`) }
    const parsed = await parseColumnAware(qBuf)
    console.log(`  parsed ${Object.keys(parsed).length} Q`)
    let answers = {}
    if (aBuf) {
      const { text } = await pdfParse(aBuf)
      answers = parseAnswersText(text)
      if (Object.keys(answers).length < 20) {
        try { answers = await parseAnswersPdfjs(aBuf) } catch (e) {}
      }
    }
    console.log(`  answers ${Object.keys(answers).length}`)
    for (const n of t.nums) {
      const pq = parsed[n]; const a = answers[n]
      if (!pq || !pq.question || !a || !/^[A-D]$/.test(a) ||
          !['A','B','C','D'].every(k => (pq.options?.[k] || '').length >= 1)) {
        console.log(`  ✗ Q${n}: ${pq ? 'ok-q' : 'no-q'}, ans=${a || '?'}`)
        skipped++; continue
      }
      const idx = data.questions.findIndex(x =>
        x.exam_code === t.code && x.subject === t.subject && x.number === n)
      const rec = {
        roc_year: t.year, session: t.session, exam_code: t.code,
        subject: t.subject, subject_tag: t.tag, subject_name: t.subject,
        stage_id: 0, number: n,
        question: stripPUA(pq.question),
        options: Object.fromEntries(['A','B','C','D'].map(k => [k, stripPUA(pq.options[k])])),
        answer: a, explanation: '',
      }
      if (idx >= 0) { rec.id = data.questions[idx].id; data.questions[idx] = rec; replaced++ }
      else { rec.id = nextId++; data.questions.push(rec); added++ }
      console.log(`  ✓ Q${n} [${a}]: ${rec.question.slice(0, 40)}`)
    }
  }
  data.total = data.questions.length
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
  console.log(`\n✅ customs: +${added} added, ${replaced} replaced, ${skipped} skipped → ${data.questions.length}`)
}

main().catch(e => { console.error(e); process.exit(1) })
