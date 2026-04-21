#!/usr/bin/env node
// Recover 105 nursing incompletes via text-layer multi-strategy extraction.
// 105030 c=106 s=0501-0505; 105090 c=106 s=0501-0505 (second session).

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false, timeout: 25000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*',
                 Referer: 'https://wwwq.moex.gov.tw/' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800)
        return reject(new Error('redirect'))
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

// Extract questions from text where layout is "N 題幹\n{options in 1/2/4 lines}\nN+1 ..."
function extractFromText(text) {
  const out = {}
  // Normalize: strip headers/footers with 代號/頁次
  const cleaned = text.replace(/代號[：:]\s*\d+\s*\n/g, '')
                      .replace(/頁次[：:]\s*\d+－\d+\s*\n/g, '')
  // Find positions of "\n N " (Arabic 1-80 with space after)
  for (let n = 1; n <= 80; n++) {
    const re = new RegExp(`\\n\\s*${n}\\s+([\\s\\S]*?)\\n\\s*${n + 1}\\s`, 'm')
    const m = cleaned.match(re)
    if (!m) continue
    const body = m[1]
    const lines = body.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length < 2) continue

    // Try to find where options start. Build (question, optsLines) combinations.
    // Strategy: split each non-first line by 2+ spaces; collect all segments.
    // Then try cuts where "first k lines = question" and remaining segments == 4.
    let matched = false
    for (let k = 1; k < lines.length; k++) {
      const qLines = lines.slice(0, k)
      const rest = lines.slice(k)
      const segs = []
      for (const l of rest) segs.push(...l.split(/\s{2,}/).filter(Boolean))
      if (segs.length === 4 && segs.every(s => s.length >= 1)) {
        out[n] = {
          question: qLines.join(' ').replace(/\s+/g, ' ').trim(),
          options: { A: segs[0], B: segs[1], C: segs[2], D: segs[3] },
        }
        matched = true; break
      }
    }
    if (matched) continue
    // Strategy B: last 4 non-empty lines as options (per-line format)
    if (lines.length >= 5) {
      const opts = lines.slice(-4)
      if (opts.every(o => o.length >= 2 && !/^[①②③④⑤]+$/.test(o))) {
        out[n] = {
          question: lines.slice(0, -4).join(' ').replace(/\s+/g, ' ').trim(),
          options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] },
        }
        continue
      }
    }
    // Strategy C: last 2 lines each split by single space into exactly 2 segs (2-col layout)
    if (lines.length >= 3) {
      const last2 = lines.slice(-2)
      const split2 = last2.map(l => l.split(/\s+/).filter(Boolean))
      if (split2.every(a => a.length === 2 && a.every(s => s.length >= 2))) {
        const opts = [...split2[0], ...split2[1]]
        out[n] = {
          question: lines.slice(0, -2).join(' ').replace(/\s+/g, ' ').trim(),
          options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] },
        }
        continue
      }
    }
    // Strategy D: last 1 line split by single space into exactly 4 (choice-code layout like "①② ②③ ③④ ①④")
    if (lines.length >= 2) {
      const last = lines[lines.length - 1]
      const segs = last.split(/\s+/).filter(Boolean)
      if (segs.length === 4 && segs.every(s => s.length >= 1)) {
        out[n] = {
          question: lines.slice(0, -1).join(' ').replace(/\s+/g, ' ').trim(),
          options: { A: segs[0], B: segs[1], C: segs[2], D: segs[3] },
        }
      }
    }

    // Fallback: Strategy where each rest line split by single space might yield 4 evenly-sized options (risky — skip)
  }
  return out
}

async function scrape(code, s) {
  const url = `${BASE}?t=Q&code=${code}&c=106&s=${s}&q=1`
  try {
    const buf = await fetchPdf(url)
    const { text } = await pdfParse(buf)
    // Header check is flaky due to pdf-parse state issues; rely on URL correctness.
    // Sanity: require some Chinese text length so we bail on error pages.
    if (text.length < 500) { console.log(`  ⚠ ${code}/${s}: text too short`); return {} }
    return extractFromText(text)
  } catch (e) { console.log(`  ⚠ ${code}/${s}: ${e.message}`); return {} }
}

const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s
const sleep = ms => new Promise(r => setTimeout(r, ms))

const SUBJECTS = [
  { s: '0501', subject: '基礎醫學' },
  { s: '0502', subject: '基本護理學與護理行政' },
  { s: '0503', subject: '內外科護理學' },
  { s: '0504', subject: '產兒科護理學' },
  { s: '0505', subject: '精神科與社區衛生護理學' },
]
const CODES = ['105030', '105090']

async function main() {
  const fp = path.join(__dirname, '..', 'questions-nursing.json')
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  let fixed = 0, tried = 0
  for (const code of CODES) {
    for (const sp of SUBJECTS) {
      console.log(`\n── ${code} ${sp.subject} (s=${sp.s}) ──`)
      let parsed = {}
      try { parsed = await scrape(code, sp.s) } catch (e) { console.log(`  ⚠ ${e.message}`); continue }
      console.log(`  parsed ${Object.keys(parsed).length} Q`)
      const targets = data.questions.filter(q =>
        q.exam_code === code && q.subject === sp.subject && q.incomplete)
      for (const q of targets) {
        tried++
        const pq = parsed[q.number]
        if (!pq || !['A','B','C','D'].every(k => (pq.options[k]||'').length >= 2)) continue
        q.options = Object.fromEntries(['A','B','C','D'].map(k => [k, stripPUA(pq.options[k])]))
        q.question = stripPUA(pq.question) || q.question
        delete q.incomplete
        delete q.gap_reason
        fixed++
      }
      console.log(`  targets=${targets.length}, fixed so far=${fixed}`)
      await sleep(400)
    }
  }
  data.total = data.questions.length
  const tmp = fp + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, fp)
  console.log(`\n✅ 105 nursing: ${fixed}/${tried} recovered`)
}

main().catch(e => { console.error(e); process.exit(1) })
