#!/usr/bin/env node
// Scrape 020-series missing sessions (vet/dental) using ABCD-prefix text parser.
// Format: "N.\n題目\nA.\nopt\nB.\nopt\nC.\nopt\nD.\nopt"

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false, timeout: 25000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*', Referer: 'https://wwwq.moex.gov.tw/' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) { res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800)
        return reject(new Error('redirect')) }
      if (res.statusCode !== 200) { res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800)
        return reject(new Error('HTTP ' + res.statusCode)) }
      const cs = []; res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    }).on('error', e => retries > 0 ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800) : reject(e))
  })
}

// Parser for "N.\n...\nA.\n...\nB.\n...\nC.\n...\nD.\n..." format
function parseABCD(text) {
  const out = {}
  // Normalize: split into tokens per line, then group
  const lines = text.split('\n').map(l => l.trim())
  // Find anchors: lines like "1.", "2.", "A.", "B.", ...
  const tokens = []
  for (const l of lines) {
    if (!l) continue
    tokens.push(l)
  }
  let i = 0
  while (i < tokens.length) {
    const m = tokens[i].match(/^(\d{1,3})\.\s*(.*)$/)
    if (!m) { i++; continue }
    const num = +m[1]
    if (num < 1 || num > 80) { i++; continue }
    // Collect question text until we hit "A." line
    const qParts = []
    if (m[2]) qParts.push(m[2])
    i++
    let optStart = -1
    while (i < tokens.length) {
      if (/^A\.\s*/.test(tokens[i]) || tokens[i] === 'A.') { optStart = i; break }
      const nm = tokens[i].match(/^(\d{1,3})\.\s*/)
      if (nm && +nm[1] > num) break
      qParts.push(tokens[i])
      i++
    }
    if (optStart < 0) continue
    // Parse A B C D
    const opts = {}
    for (const letter of ['A','B','C','D']) {
      if (i >= tokens.length) break
      const lm = tokens[i].match(new RegExp('^' + letter + '\\.\\s*(.*)$'))
      if (!lm) break
      const parts = []
      if (lm[1]) parts.push(lm[1])
      i++
      while (i < tokens.length) {
        if (/^[A-D]\.\s*/.test(tokens[i])) break
        const nm = tokens[i].match(/^(\d{1,3})\.\s*/)
        if (nm && +nm[1] > num) break
        parts.push(tokens[i])
        i++
      }
      opts[letter] = parts.join(' ').replace(/\s+/g,' ').trim()
    }
    if (!opts.A || !opts.B || !opts.C || !opts.D) continue
    out[num] = { question: qParts.join(' ').replace(/\s+/g,' ').trim(), options: opts }
  }
  return out
}

// Answer parser: full-width ＡＢＣＤ in answer rows; letters appear in order 1-80.
// PDF has "題號" row then "答案" row with ~20 letters per row, 4 rows total.
async function parseAnswersPdfjs(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise
  const ans = {}
  const LETTERS = new Set(['Ａ','Ｂ','Ｃ','Ｄ','A','B','C','D'])
  const toHalf = c => ({ 'Ａ':'A','Ｂ':'B','Ｃ':'C','Ｄ':'D' })[c] || c
  const letterItems = []
  for (let pi = 1; pi <= doc.numPages; pi++) {
    const page = await doc.getPage(pi)
    const content = await page.getTextContent()
    for (const it of content.items) {
      const s = it.str.trim()
      if (s.length !== 1 || !LETTERS.has(s)) continue
      letterItems.push({ str: toHalf(s), page: pi, x: it.transform[4], y: it.transform[5] })
    }
  }
  // Group by (page, y)
  letterItems.sort((a,b) => a.page - b.page || b.y - a.y || a.x - b.x)
  const rows = []
  for (const it of letterItems) {
    const last = rows[rows.length-1]
    if (last && last.page === it.page && Math.abs(last.y - it.y) < 3) last.parts.push(it)
    else rows.push({ page: it.page, y: it.y, parts: [it] })
  }
  // Keep rows with >= 10 letters (answer rows)
  const answerRows = rows.filter(r => r.parts.length >= 10)
  let n = 1
  for (const r of answerRows) {
    r.parts.sort((a,b) => a.x - b.x)
    for (const p of r.parts) {
      if (n > 80) break
      ans[n++] = p.str
    }
  }
  return ans
}

const TARGETS = [
  // vet 102-104 (c=307)
  ...['102020','102100','103020','103090','104020'].map(code => ({
    file: 'questions-vet.json', code, roc: code.slice(0,3),
    session: /020$/.test(code) ? '第一次' : '第二次',
    stage_id: 0, c: '307',
    papers: [
      { s: '11', subject: '獸醫病理學',   tag: 'vet_pathology',     name: '獸醫病理學' },
      { s: '22', subject: '獸醫藥理學',   tag: 'vet_pharmacology',  name: '獸醫藥理學' },
      { s: '33', subject: '獸醫實驗診斷學', tag: 'vet_lab_diagnosis', name: '獸醫實驗診斷學' },
      { s: '44', subject: '獸醫普通疾病學', tag: 'vet_common_disease',name: '獸醫普通疾病學' },
      { s: '55', subject: '獸醫傳染病學',   tag: 'vet_infectious',    name: '獸醫傳染病學' },
      { s: '66', subject: '獸醫公共衛生學', tag: 'vet_public_health', name: '獸醫公共衛生學' },
    ]
  })),
  // vet 104-二 and 105 (c=314)
  ...['104090','105020','105100'].map(code => ({
    file: 'questions-vet.json', code, roc: code.slice(0,3),
    session: /(020|030)$/.test(code) ? '第一次' : '第二次',
    stage_id: 0, c: '314',
    papers: [
      { s: '11', subject: '獸醫病理學',   tag: 'vet_pathology',     name: '獸醫病理學' },
      { s: '22', subject: '獸醫藥理學',   tag: 'vet_pharmacology',  name: '獸醫藥理學' },
      { s: '33', subject: '獸醫實驗診斷學', tag: 'vet_lab_diagnosis', name: '獸醫實驗診斷學' },
      { s: '44', subject: '獸醫普通疾病學', tag: 'vet_common_disease',name: '獸醫普通疾病學' },
      { s: '55', subject: '獸醫傳染病學',   tag: 'vet_infectious',    name: '獸醫傳染病學' },
      { s: '66', subject: '獸醫公共衛生學', tag: 'vet_public_health', name: '獸醫公共衛生學' },
    ]
  })),
  // dental1 104-一 (c=301)
  { file: 'questions-dental1.json', code: '104020', roc: '104', session: '第一次', stage_id: 1, c: '301',
    papers: [
      { s: '11', subject: '卷一', tag: 'dental_anatomy',   name: '牙醫學(一)' },
      { s: '22', subject: '卷二', tag: 'oral_pathology',   name: '牙醫學(二)' },
    ]},
  // dental2 104-一 (c=302)
  { file: 'questions-dental2.json', code: '104020', roc: '104', session: '第一次', stage_id: 5, c: '302',
    papers: [
      { s: '33', subject: '卷一', tag: 'periodontics',              name: '牙醫學(三)' },
      { s: '44', subject: '卷二', tag: 'endodontics',               name: '牙醫學(四)' },
      { s: '55', subject: '卷三', tag: 'removable_prosthodontics',  name: '牙醫學(五)' },
      { s: '66', subject: '卷四', tag: 'dental_public_health',      name: '牙醫學(六)' },
    ]},
  // dental2 104-二 (c=304, s=44 blank)
  { file: 'questions-dental2.json', code: '104090', roc: '104', session: '第二次', stage_id: 5, c: '304',
    papers: [
      { s: '33', subject: '卷一', tag: 'periodontics',              name: '牙醫學(三)' },
      { s: '55', subject: '卷三', tag: 'removable_prosthodontics',  name: '牙醫學(五)' },
      { s: '66', subject: '卷四', tag: 'dental_public_health',      name: '牙醫學(六)' },
    ]},
  // dental2 105-一/二 (c=304)
  { file: 'questions-dental2.json', code: '105020', roc: '105', session: '第一次', stage_id: 5, c: '304',
    papers: [
      { s: '33', subject: '卷一', tag: 'periodontics',              name: '牙醫學(三)' },
      { s: '44', subject: '卷二', tag: 'endodontics',               name: '牙醫學(四)' },
      { s: '55', subject: '卷三', tag: 'removable_prosthodontics',  name: '牙醫學(五)' },
      { s: '66', subject: '卷四', tag: 'dental_public_health',      name: '牙醫學(六)' },
    ]},
  { file: 'questions-dental2.json', code: '105100', roc: '105', session: '第二次', stage_id: 5, c: '304',
    papers: [
      { s: '33', subject: '卷一', tag: 'periodontics',              name: '牙醫學(三)' },
      { s: '44', subject: '卷二', tag: 'endodontics',               name: '牙醫學(四)' },
      { s: '55', subject: '卷三', tag: 'removable_prosthodontics',  name: '牙醫學(五)' },
      { s: '66', subject: '卷四', tag: 'dental_public_health',      name: '牙醫學(六)' },
    ]},
]

async function scrapePaper(t, p) {
  const qUrl = `${BASE}?t=Q&code=${t.code}&c=${t.c}&s=${p.s}&q=1`
  const aUrl = `${BASE}?t=S&code=${t.code}&c=${t.c}&s=${p.s}&q=1`
  const qBuf = await fetchPdf(qUrl)
  const { text: qText } = await pdfParse(qBuf)
  if (qText.length < 500) throw new Error('question PDF too short')
  const parsed = parseABCD(qText)
  await sleep(300)
  let answers = {}
  try {
    const aBuf = await fetchPdf(aUrl)
    answers = await parseAnswersPdfjs(aBuf)
  } catch (e) { /* continue without answers */ }
  const qs = []
  for (let n = 1; n <= 80; n++) {
    const pq = parsed[n]
    const ans = answers[n]
    if (!pq || !ans) continue
    if (!['A','B','C','D'].every(k => (pq.options[k]||'').length >= 2)) continue
    qs.push({
      id: `${t.code}_${p.s}_${n}`,
      roc_year: t.roc,
      session: t.session,
      exam_code: t.code,
      subject: p.subject,
      subject_tag: p.tag,
      subject_name: p.name,
      stage_id: t.stage_id,
      number: n,
      question: stripPUA(pq.question),
      options: Object.fromEntries(['A','B','C','D'].map(k => [k, stripPUA(pq.options[k])])),
      answer: ans,
      explanation: '',
    })
  }
  return qs
}

async function main() {
  const byFile = new Map()
  for (const t of TARGETS) {
    if (!byFile.has(t.file)) byFile.set(t.file, [])
    byFile.get(t.file).push(t)
  }
  for (const [file, ts] of byFile) {
    const fp = path.join(__dirname, '..', file)
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    const existingKeys = new Set(data.questions.map(q => `${q.exam_code}_${q.subject}_${q.number}`))
    let totalAdded = 0
    for (const t of ts) {
      for (const p of t.papers) {
        try {
          const qs = await scrapePaper(t, p)
          console.log(`  ${file} ${t.code} ${p.subject}(${p.s}) → ${qs.length}/80`)
          for (const q of qs) {
            const k = `${q.exam_code}_${q.subject}_${q.number}`
            if (existingKeys.has(k)) continue
            data.questions.push(q)
            existingKeys.add(k)
            totalAdded++
          }
        } catch (e) {
          console.log(`  ⚠ ${file} ${t.code} ${p.s}: ${e.message}`)
        }
        await sleep(400)
      }
    }
    data.total = data.questions.length
    const tmp = fp + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, fp)
    console.log(`✅ ${file}: +${totalAdded}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
