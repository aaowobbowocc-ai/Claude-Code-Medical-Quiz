#!/usr/bin/env node
// Fix nursing 105030 incompletes (39 records with A/C blank) using pdf-parse text layout.
// Layout: "N 題幹\n" then options as 4 items (mixture of 1×4, 2×2, 4×1 lines).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

const UA = 'Mozilla/5.0 Chrome/131.0.0.0'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s

function fetchPdf(url) {
  return new Promise((ok, no) => https.get(url, { rejectUnauthorized: false, timeout: 25000,
    headers: { 'User-Agent': UA, Referer: 'https://wwwq.moex.gov.tw/' } }, r => {
    if (r.statusCode !== 200) { r.resume(); return no(new Error('HTTP ' + r.statusCode)) }
    const cs = []; r.on('data', c => cs.push(c)); r.on('end', () => ok(Buffer.concat(cs)))
  }).on('error', no))
}

function parse(text) {
  const out = {}
  const clean = text.replace(/代號[：:]\s*\d+\s*\n/g, '').replace(/頁次[：:]\s*\d+－\d+\s*\n/g, '')
  for (let n = 1; n <= 80; n++) {
    const re = n === 80
      ? /\n\s*80\s+([\s\S]+?)(?:\n\s*代號|\n\s*頁次|$)/
      : new RegExp(`\\n\\s*${n}\\s+([\\s\\S]*?)\\n\\s*${n + 1}\\s`, 'm')
    const m = clean.match(re)
    if (!m) continue
    const lines = m[1].split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length < 2) continue
    const put = (q, o) => { out[n] = { question: q.replace(/\s+/g,' ').trim(), options: { A:o[0], B:o[1], C:o[2], D:o[3] } } }
    // Strategy A: last 4 lines = 4 options
    if (lines.length >= 5) {
      const opts = lines.slice(-4)
      if (opts.every(o => o.length >= 2)) { put(lines.slice(0,-4).join(' '), opts); continue }
    }
    // Strategy B: last 2 lines, prefer 2+ space split
    if (lines.length >= 3) {
      const sp2 = lines.slice(-2).map(l => l.split(/\s{2,}/).filter(Boolean))
      if (sp2.every(a => a.length === 2 && a.every(s => s.length >= 2))) {
        put(lines.slice(0,-2).join(' '), [...sp2[0], ...sp2[1]]); continue
      }
    }
    // Strategy C: last line 4 options with 2+ space split
    const last = lines[lines.length - 1]
    const seg2 = last.split(/\s{2,}/).filter(Boolean)
    if (seg2.length === 4 && seg2.every(s => s.length >= 1)) {
      put(lines.slice(0,-1).join(' '), seg2); continue
    }
    // Strategy D: last line whitespace split, N tokens pair-grouped (e.g. "3200 mL 4200 mL 5200 mL 6200 mL")
    const seg1 = last.split(/\s+/).filter(Boolean)
    if (seg1.length === 8) {
      const opts = [seg1[0]+' '+seg1[1], seg1[2]+' '+seg1[3], seg1[4]+' '+seg1[5], seg1[6]+' '+seg1[7]]
      put(lines.slice(0,-1).join(' '), opts); continue
    }
    if (seg1.length === 4 && seg1.every(s => s.length >= 1)) {
      put(lines.slice(0,-1).join(' '), seg1); continue
    }
    // Strategy E: last 2 lines loose whitespace, each has 4 tokens pair-grouped
    if (lines.length >= 3) {
      const sp = lines.slice(-2).map(l => l.split(/\s+/).filter(Boolean))
      if (sp.every(a => a.length === 4)) {
        const a = [sp[0][0]+' '+sp[0][1], sp[0][2]+' '+sp[0][3], sp[1][0]+' '+sp[1][1], sp[1][2]+' '+sp[1][3]]
        put(lines.slice(0,-2).join(' '), a); continue
      }
      if (sp.every(a => a.length === 2 && a.every(s => s.length >= 2))) {
        put(lines.slice(0,-2).join(' '), [...sp[0], ...sp[1]]); continue
      }
    }
    // Strategy F: paren-delimited options  「中文（English）」
    if (lines.length >= 3) {
      const lastTwo = lines.slice(-2).join(' ')
      const parens = lastTwo.match(/[^）\s][^）]*?）/g)
      if (parens && parens.length === 4 && parens.every(s => s.length >= 3)) {
        put(lines.slice(0,-2).join(' '), parens.map(s=>s.trim())); continue
      }
    }
    // Strategy G: last 2 lines with equal token count, N tokens each → group N/2 per option
    if (lines.length >= 3) {
      const sp = lines.slice(-2).map(l => l.split(/\s+/).filter(Boolean))
      if (sp[0].length === sp[1].length && sp[0].length >= 2 && sp[0].length % 2 === 0) {
        const k = sp[0].length / 2
        const opts = [
          sp[0].slice(0,k).join(' '), sp[0].slice(k).join(' '),
          sp[1].slice(0,k).join(' '), sp[1].slice(k).join(' '),
        ]
        if (opts.every(o=>o.length>=2)) { put(lines.slice(0,-2).join(' '), opts); continue }
      }
    }
  }
  return out
}

const PAPERS = [
  { s: '0501', subject: '基礎醫學' },
  { s: '0502', subject: '基本護理學與護理行政' },
  { s: '0503', subject: '內外科護理學' },
  { s: '0504', subject: '產兒科護理學' },
  { s: '0505', subject: '精神科與社區衛生護理學' },
]

async function main() {
  const fp = path.join(__dirname, '..', 'questions-nursing.json')
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  let fixed = 0
  for (const p of PAPERS) {
    const url = `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=Q&code=105030&c=106&s=${p.s}&q=1`
    const buf = await fetchPdf(url)
    const { text } = await pdfParse(buf)
    const parsed = parse(text)
    const good = Object.values(parsed).filter(q => ['A','B','C','D'].every(k => (q.options[k]||'').length >= 1)).length
    console.log(`${p.subject}: parsed ${good}/80`)
    // Index existing records for this code+subject
    for (const q of data.questions) {
      if (q.exam_code !== '105030' || q.subject !== p.subject || !q.incomplete) continue
      const pq = parsed[q.number]
      if (!pq) continue
      const opts = ['A','B','C','D'].map(k => stripPUA(pq.options[k]||''))
      if (!opts.every(o => o.length >= 1)) continue
      q.options = { A: opts[0], B: opts[1], C: opts[2], D: opts[3] }
      q.question = stripPUA(pq.question) || q.question
      delete q.incomplete
      delete q.gap_reason
      fixed++
    }
    await sleep(300)
  }
  fs.writeFileSync(fp + '.tmp', JSON.stringify(data, null, 2))
  fs.renameSync(fp + '.tmp', fp)
  console.log(`\n✅ nursing 105030: fixed ${fixed} incompletes`)
}
main().catch(e => { console.error(e); process.exit(1) })
