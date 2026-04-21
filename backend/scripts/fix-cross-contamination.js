#!/usr/bin/env node
// Fix cross-contamination found by audit-cross-contamination.js:
//   • tcm2 102030 臨床(一)(二)(三)(四) — full replace from c=103 s=0203-0206
//   • tcm1 102030 suspicious Qs (Q50, Q12, Q23, Q58) from c=103 s=0201,0202
//   • tcm1 103030 suspicious Qs (Q38, Q67, Q80) from c=103 s=0201,0202

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
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location; res.resume()
        if (!loc || !loc.startsWith('http')) return reject(new Error('redirect→' + loc))
        return fetchPdf(loc, retries).then(resolve, reject)
      }
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
  if (Object.keys(answers).length >= 20) return answers
  const hw = /答案\s*([A-Da-d#＃]+)/g
  let hm; n = 1
  while ((hm = hw.exec(text)) !== null) {
    for (const ch of hm[1]) {
      if (ch === '#' || ch === '＃') { n++; continue }
      answers[n++] = ch.toUpperCase()
    }
  }
  return answers
}

const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function scrapePaper(code, c, s) {
  const qUrl = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
  const aUrl = `${BASE}?t=S&code=${code}&c=${c}&s=${s}&q=1`
  const qBuf = await fetchPdf(qUrl)
  let aBuf = null
  try { aBuf = await fetchPdf(aUrl) } catch (e) { console.log(`  ⚠ answer fetch failed: ${e.message}`) }
  const parsed = await parseColumnAware(qBuf)
  const aText = aBuf ? (await pdfParse(aBuf)).text : ''
  const answers = parseAnswers(aText)
  return { parsed, answers }
}

// ─── TCM2 102030 full replace ────────────────────────────────
const TCM2_PAPERS = [
  { s: '0203', subject: '中醫臨床醫學(一)', tag: 'tcm_clinical_1' },
  { s: '0204', subject: '中醫臨床醫學(二)', tag: 'tcm_clinical_2' },
  { s: '0205', subject: '中醫臨床醫學(三)', tag: 'tcm_clinical_3' },
  { s: '0206', subject: '中醫臨床醫學(四)', tag: 'tcm_clinical_4' },
]

// ─── Targeted TCM1 fixes ─────────────────────────────────────
const TCM1_TARGETS = [
  { code: '102030', s: '0201', subject: '中醫基礎醫學(一)', tag: 'tcm_basic_1', nums: [50] },
  { code: '102030', s: '0202', subject: '中醫基礎醫學(二)', tag: 'tcm_basic_2', nums: [12, 23, 58] },
  { code: '103030', s: '0201', subject: '中醫基礎醫學(一)', tag: 'tcm_basic_1', nums: [38] },
  { code: '103030', s: '0202', subject: '中醫基礎醫學(二)', tag: 'tcm_basic_2', nums: [67, 80] },
]

async function fixTcm2() {
  const file = path.join(__dirname, '..', 'questions-tcm2.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
  let nextId = Math.max(...data.questions.map(q => q.id || 0)) + 1
  let replaced = 0, added = 0, skipped = 0
  for (const p of TCM2_PAPERS) {
    console.log(`\n── tcm2 102030 ${p.subject} (c=103 s=${p.s}) ──`)
    const { parsed, answers } = await scrapePaper('102030', '103', p.s)
    const nums = Object.keys(parsed).map(Number).sort((a,b)=>a-b)
    console.log(`  parsed: ${nums.length} Q, ${Object.keys(answers).length} A`)
    for (const n of nums) {
      const pq = parsed[n]
      const a = answers[n]
      if (!pq || !pq.question || !a || !/^[A-D]$/.test(a)) { skipped++; continue }
      if (!['A','B','C','D'].every(k => (pq.options[k]||'').length >= 1)) { skipped++; continue }
      const idx = data.questions.findIndex(x =>
        x.exam_code === '102030' && x.subject === p.subject && x.number === n)
      const rec = {
        roc_year: '102', session: '第一次', exam_code: '102030',
        subject: p.subject, subject_tag: p.tag, subject_name: p.subject,
        stage_id: 0, number: n,
        question: stripPUA(pq.question),
        options: Object.fromEntries(['A','B','C','D'].map(k=>[k, stripPUA(pq.options[k])])),
        answer: a, explanation: '',
      }
      if (idx >= 0) { rec.id = data.questions[idx].id; data.questions[idx] = rec; replaced++ }
      else { rec.id = nextId++; data.questions.push(rec); added++ }
    }
    await sleep(500)
  }
  data.total = data.questions.length
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
  console.log(`\n✅ tcm2: ${replaced} replaced, ${added} added, ${skipped} skipped → ${data.questions.length} total`)
}

async function fixTcm1() {
  const file = path.join(__dirname, '..', 'questions-tcm1.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
  let nextId = Math.max(...data.questions.map(q => q.id || 0)) + 1
  let replaced = 0, added = 0, skipped = 0
  for (const t of TCM1_TARGETS) {
    console.log(`\n── tcm1 ${t.code} ${t.subject} (c=103 s=${t.s}) ──`)
    const { parsed, answers } = await scrapePaper(t.code, '103', t.s)
    console.log(`  parsed ${Object.keys(parsed).length} Q`)
    for (const n of t.nums) {
      const pq = parsed[n]
      const a = answers[n]
      if (!pq || !a || !/^[A-D]$/.test(a) || !['A','B','C','D'].every(k=>(pq.options[k]||'').length>=1)) {
        console.log(`  ✗ Q${n}: incomplete`)
        skipped++; continue
      }
      const year = t.code.slice(0, 3)
      const idx = data.questions.findIndex(x =>
        x.exam_code === t.code && x.subject === t.subject && x.number === n)
      const rec = {
        roc_year: year, session: '第一次', exam_code: t.code,
        subject: t.subject, subject_tag: t.tag, subject_name: t.subject,
        stage_id: 0, number: n,
        question: stripPUA(pq.question),
        options: Object.fromEntries(['A','B','C','D'].map(k=>[k, stripPUA(pq.options[k])])),
        answer: a, explanation: '',
      }
      const oldQ = idx >= 0 ? data.questions[idx].question.slice(0, 40) : null
      if (idx >= 0) { rec.id = data.questions[idx].id; data.questions[idx] = rec; replaced++ }
      else { rec.id = nextId++; data.questions.push(rec); added++ }
      console.log(`  ✓ Q${n}: ${idx >= 0 ? 'replaced' : 'added'}`)
      if (oldQ) console.log(`     OLD: ${oldQ}`)
      console.log(`     NEW: ${rec.question.slice(0, 40)}`)
    }
    await sleep(500)
  }
  data.total = data.questions.length
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
  console.log(`\n✅ tcm1: ${replaced} replaced, ${added} added, ${skipped} skipped → ${data.questions.length} total`)
}

async function main() {
  const only = (process.argv.find(a=>a.startsWith('--only='))||'').split('=')[1]
  if (!only || only === 'tcm2') await fixTcm2()
  if (!only || only === 'tcm1') await fixTcm1()
}

main().catch(e => { console.error(e); process.exit(1) })
