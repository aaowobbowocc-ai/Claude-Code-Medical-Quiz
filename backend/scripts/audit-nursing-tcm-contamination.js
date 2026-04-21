#!/usr/bin/env node
// Read-only audit: compare each nursing question in 106030-109110 vs the
// authoritative MoEX PDF (c=106, s=0501-0505) and report mismatches.
// No writes. Output is a summary + detailed list to stdout.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

const SESSIONS = [
  { year: '106', code: '106030' }, { year: '106', code: '106110' },
  { year: '107', code: '107030' }, { year: '107', code: '107110' },
  { year: '108', code: '108020' }, { year: '108', code: '108110' },
  { year: '109', code: '109030' }, { year: '109', code: '109110' },
]
const SUBJECTS = [
  { s: '0501', subject: '基礎醫學' },
  { s: '0502', subject: '基本護理學與護理行政' },
  { s: '0503', subject: '內外科護理學' },
  { s: '0504', subject: '產兒科護理學' },
  { s: '0505', subject: '精神科與社區衛生護理學' },
]

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
      const cs = []
      res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    }).on('error', e => retries > 0 ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800) : reject(e))
  })
}

// Extract Q stems only (not full options) — enough for a content-similarity check
function extractQuestionStems(text) {
  const out = {}
  const lines = text.replace(/\r\n/g, '\n').split('\n').map(l => l.trim()).filter(Boolean)
  let curNum = null, buf = []
  for (const line of lines) {
    const m = line.match(/^(\d{1,3})\s+(.+)$/)
    if (m) {
      const n = parseInt(m[1])
      const rest = m[2]
      // only accept if n is next sequential number OR 1
      if ((curNum === null && n === 1) || n === (curNum || 0) + 1) {
        if (curNum !== null) out[curNum] = buf.join(' ')
        curNum = n
        buf = [rest]
        continue
      }
    }
    if (curNum !== null) buf.push(line)
  }
  if (curNum !== null) out[curNum] = buf.join(' ')
  return out
}

function similar(a, b) {
  // normalize: keep only CJK + alpha chars
  const norm = s => (s||'').replace(/[^\u4e00-\u9fff A-Za-z0-9]/g, '').slice(0, 60)
  const A = norm(a), B = norm(b)
  if (!A || !B) return 0
  let match = 0
  const len = Math.min(A.length, B.length)
  for (let i = 0; i < len; i++) if (A[i] === B[i]) match++
  return match / Math.max(A.length, B.length)
}

async function main() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'questions-nursing.json'), 'utf-8'))
  let total = 0, mismatch = 0, missingPdf = 0
  const bad = []
  for (const sess of SESSIONS) {
    for (const sub of SUBJECTS) {
      const url = `${BASE}?t=Q&code=${sess.code}&c=106&s=${sub.s}&q=1`
      let text
      try {
        const buf = await fetchPdf(url)
        text = (await pdfParse(buf)).text
      } catch (e) {
        console.log(`⚠ ${sess.code} ${sub.subject}: fetch failed (${e.message})`)
        continue
      }
      // Verify header says 護理師
      if (!text.includes('護理師')) {
        console.log(`⚠ ${sess.code} ${sub.subject}: PDF header not 護理師, skipping`)
        continue
      }
      const pdfStems = extractQuestionStems(text)
      const dbQs = data.questions.filter(q => q.exam_code === sess.code && q.subject === sub.subject)
      for (const q of dbQs) {
        total++
        const pdfStem = pdfStems[q.number]
        if (!pdfStem) { missingPdf++; continue }
        const sim = similar(q.question, pdfStem)
        if (sim < 0.4) {
          mismatch++
          bad.push({ code: sess.code, subject: sub.subject, n: q.number,
                     dbQ: q.question.slice(0,40), pdfQ: pdfStem.slice(0,40), sim: sim.toFixed(2) })
        }
      }
      console.log(`  ${sess.code} ${sub.subject}: ${dbQs.length} DB q, ${Object.keys(pdfStems).length} PDF q`)
      await new Promise(r => setTimeout(r, 400))
    }
  }
  console.log(`\n=== SUMMARY ===`)
  console.log(`Total DB questions checked: ${total}`)
  console.log(`Mismatches (likely contamination): ${mismatch}`)
  console.log(`DB Q not in PDF (truly missing): ${missingPdf}`)
  if (bad.length) {
    console.log(`\n=== MISMATCHES ===`)
    for (const b of bad.slice(0, 100)) {
      console.log(`  ${b.code} ${b.subject} Q${b.n} sim=${b.sim}`)
      console.log(`    DB : ${b.dbQ}`)
      console.log(`    PDF: ${b.pdfQ}`)
    }
    if (bad.length > 100) console.log(`  ... (${bad.length - 100} more)`)
  }
  fs.writeFileSync(path.join(__dirname, '..', '_tmp', 'nursing-audit.json'),
    JSON.stringify(bad, null, 2))
  console.log(`\nFull list written to _tmp/nursing-audit.json`)
}

main().catch(e => { console.error(e); process.exit(1) })
