#!/usr/bin/env node
// Fill column-parser gaps in civil-senior 100-105 (questions-civil-senior.json)
// via pdfjs position data + decodePUA. Targets verified by gap audit 2026-05-20.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfjsLib = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')
const pdfParse = require('pdf-parse')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const OUT = path.join(__dirname, '..', 'questions-civil-senior.json')
const APPLY = process.argv.includes('--apply')

// (year, code, c, s, subject, subject_tag)
const TARGETS = [
  ['103', '103080', '201', '0503', '行政法',         'admin_law'],
  ['104', '104080', '201', '0503', '行政法',         'admin_law'],
  ['104', '104080', '201', '0111', '法學知識與英文', 'law_knowledge_english'],
  ['105', '105080', '201', '0504', '行政學',         'admin_studies'],
]

function fetchPdf(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized: false, timeout: 20000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(String(res.statusCode))) }
      const cs = []; res.on('data', c => cs.push(c)); res.on('end', () => resolve(Buffer.concat(cs)))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function decodePUA(s) {
  if (s.length !== 1) return s
  const code = s.charCodeAt(0)
  if (code >= 0xE0C6 && code <= 0xE0CF) return String(code - 0xE0C6 + 1)
  if (code >= 0xE000 && code <= 0xF8FF) return ''
  return s
}

async function extractPositionedText(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const items = []
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent()
    for (const it of content.items) {
      const s = decodePUA(it.str)
      if (!s.trim()) continue
      items.push({ x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), page: p, str: s })
    }
  }
  items.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)
  return items
}

function buildLogicalLines(items) {
  const rows = []
  let curY = null, curRow = []
  for (const it of items) {
    if (curY === null || Math.abs(it.y - curY) > 3) {
      if (curRow.length) rows.push(curRow)
      curRow = [it]; curY = it.y
    } else curRow.push(it)
  }
  if (curRow.length) rows.push(curRow)
  const lines = []
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x)
    const gaps = []
    for (let i = 1; i < row.length; i++) {
      const prevEnd = row[i - 1].x + row[i - 1].str.length * 11
      if (row[i].x - prevEnd > 30 || row[i].x - row[i - 1].x > 80) gaps.push(i)
    }
    if (gaps.length >= 3) {
      const breaks = [0, ...gaps, row.length]
      for (let b = 0; b < breaks.length - 1; b++) {
        const chunk = row.slice(breaks[b], breaks[b + 1])
        const text = chunk.map(r => r.str).join('').trim()
        if (text) lines.push({ text, x: chunk[0].x, y: row[0].y, col: 'C' + b })
      }
    } else if (gaps.length >= 1) {
      const left = row.slice(0, gaps[0]).map(r => r.str).join('').trim()
      const right = row.slice(gaps[0]).map(r => r.str).join('').trim()
      if (left) lines.push({ text: left, x: row[0].x, y: row[0].y, col: 'L' })
      if (right) lines.push({ text: right, x: row[gaps[0]].x, y: row[0].y, col: 'R' })
    } else {
      const text = row.map(r => r.str).join('').trim()
      if (text) lines.push({ text, x: row[0].x, y: row[0].y, col: 'F' })
    }
  }
  return lines
}

function extractOptions(items) {
  if (!items.length) return []
  const groups = []
  let curY = null, cur = []
  for (const it of items) {
    if (curY === null || Math.abs(it.y - curY) > 3) {
      if (cur.length) groups.push(cur)
      cur = [it]; curY = it.y
    } else cur.push(it)
  }
  if (cur.length) groups.push(cur)
  const opts = []
  for (const g of groups) {
    g.sort((a, b) => a.x - b.x)
    const cols = new Set(g.map(it => it.col))
    if (cols.has('C0') || cols.has('C1') || cols.has('C2') || cols.has('C3')) {
      for (const it of g) opts.push(it.text)
    } else if (cols.has('L') && cols.has('R')) {
      opts.push(g.filter(it => it.col === 'L').map(it => it.text).join(''))
      opts.push(g.filter(it => it.col === 'R').map(it => it.text).join(''))
    } else {
      const full = g.map(it => it.text).join('')
      if (opts.length && g[0].x > 65 && g[0].col === 'F' && full.length < 6) opts[opts.length - 1] += full
      else opts.push(full)
    }
  }
  return opts
}

function parseQuestions(lines) {
  const filtered = lines.filter(l => {
    const t = l.text
    if (/^(代號|類\s*科|科\s*目|考試|頁次|等\s*別|本試題|座號|※|禁止|本科目|須用|共\d+題|甲、|乙、|申論題|測驗題)/.test(t)) return false
    if (/^\d+－\d+$/.test(t)) return false
    if (/^\d{3,4}年/.test(t)) return false
    return true
  })
  const qStarts = []
  let expectNext = 1
  for (let i = 0; i < filtered.length; i++) {
    const line = filtered[i]
    if (line.x > 95) continue
    const es = String(expectNext)
    if (line.text.startsWith(es)) {
      const rest = line.text.slice(es.length)
      if (!rest.length) continue
      if (/^年\s*(第|公務|專門|國家|特種)/.test(rest)) continue
      qStarts.push({ idx: i, number: expectNext })
      expectNext++
    }
  }
  const questions = []
  for (let qi = 0; qi < qStarts.length; qi++) {
    const start = qStarts[qi].idx
    const end = qi + 1 < qStarts.length ? qStarts[qi + 1].idx : filtered.length
    const num = qStarts[qi].number
    const block = filtered.slice(start, end)
    let stem = block[0].text.slice(String(num).length).trim()
    stem = stem.replace(new RegExp('^\\.\\s*' + num + '\\s*'), '')
    const rest = block.slice(1)
    let stemEndIdx = 0
    let ended = stem.includes('？') || stem.includes('：')
    if (!ended) {
      for (let ri = 0; ri < rest.length; ri++) {
        if (rest[ri].text.includes('？') || rest[ri].text.includes('：')) { stemEndIdx = ri + 1; ended = true; break }
      }
    }
    const stemParts = [stem]
    for (let ri = 0; ri < stemEndIdx; ri++) stemParts.push(rest[ri].text)
    const opts = extractOptions(rest.slice(stemEndIdx))
    if (opts.length >= 2) {
      const options = {}
      const labels = ['A', 'B', 'C', 'D']
      for (let oi = 0; oi < Math.min(opts.length, 4); oi++) options[labels[oi]] = opts[oi]
      questions.push({ number: num, question: stemParts.join(' ').trim(), options })
    }
  }
  return questions
}

async function parseAnswers(buf) {
  const { text } = await pdfParse(buf)
  const ans = {}
  const fw = /答案\s*([ＡＢＣＤ]+)/g
  let m, n = 1
  while ((m = fw.exec(text)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) ans[n++] = k
    }
  }
  if (Object.keys(ans).length >= 5) return ans
  // half-width 答案ABCD
  n = 1
  const hw = /答案\s*([A-D]{5,})/g
  while ((m = hw.exec(text)) !== null) for (const ch of m[1]) ans[n++] = ch
  if (Object.keys(ans).length >= 5) return ans
  // tabular fallback
  let cleaned = text.replace(/第\d{1,3}題/g, '').replace(/題號/g, '').replace(/答案/g, '')
    .replace(/標準/g, '').replace(/[\s\n\r]+/g, '')
  let idx = 1
  for (const ch of cleaned) if ('ABCD'.includes(ch)) ans[idx++] = ch
  return ans
}

const stripPUA = s => typeof s === 'string' ? s.replace(/[-]/g, '').trim() : s

async function main() {
  const data = JSON.parse(fs.readFileSync(OUT, 'utf-8'))
  const qs = data.questions
  let nextId = Math.max(0, ...qs.map(q => Number(q.id) || 0)) + 1
  const haveKey = new Set(qs.map(q => `${q.exam_code}_${q.number}_${q.subject_tag}`))
  const added = []

  for (const [year, code, c, s, subject, tag] of TARGETS) {
    console.log(`\n▶ ${year} ${subject} (${code} c=${c} s=${s})`)
    let qbuf, abuf
    try { qbuf = await fetchPdf(`${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`) } catch (e) { console.log(`  ✗ ${e.message}`); continue }
    try { abuf = await fetchPdf(`${BASE}?t=S&code=${code}&c=${c}&s=${s}&q=1`) } catch { abuf = null }
    let items = await extractPositionedText(qbuf)
    const mcqIdx = items.findIndex(it => /測驗題|選擇題/.test(it.str))
    if (mcqIdx >= 0) items = items.slice(mcqIdx)
    const parsed = parseQuestions(buildLogicalLines(items))
    const answers = abuf ? await parseAnswers(abuf) : {}
    let n = 0
    for (const q of parsed) {
      const key = `${code}_${q.number}_${tag}`
      if (haveKey.has(key)) continue
      const ans = answers[q.number]
      if (!ans) continue
      const opts = {}
      for (const k of ['A', 'B', 'C', 'D']) opts[k] = stripPUA(q.options[k] || '')
      if (Object.values(opts).filter(Boolean).length < 4) continue
      added.push({
        id: nextId++, roc_year: year, session: '第一次', exam_code: code,
        subject, subject_tag: tag, subject_name: subject, stage_id: 0,
        number: q.number, question: stripPUA(q.question), options: opts,
        answer: ans, explanation: '',
      })
      haveKey.add(key); n++
      console.log(`  + Q${q.number} ${ans}`)
    }
    console.log(`  ${n} recovered`)
  }
  console.log(`\n總回補 ${added.length}`)
  if (added.length && APPLY) {
    qs.push(...added)
    data.total = qs.length
    const tmp = OUT + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, OUT)
    console.log(`✅ ${OUT} → ${data.total}`)
  } else if (!APPLY) console.log('(no --apply)')
}
main().catch(e => { console.error(e); process.exit(1) })
