#!/usr/bin/env node
// Fill whole-missing papers from MoEX. Each TARGET = one (exam-file, MoEX code,
// c, s) → one paper. Downloads Q+S PDF, verifies exam name, parses (positioned
// parser + column fallback), appends to the exam JSON. Idempotent.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs'), path = require('path')
const { fetchPdf } = require('./lib/pdf-fetcher')
const pdfjsLib = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')
const pdfParse = require('pdf-parse')
let columnParser = null
try { columnParser = require('./lib/moex-column-parser') } catch {}

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PUA = new RegExp('[\\uE000-\\uF8FF]', 'g')
const clean = s => typeof s === 'string' ? s.normalize('NFC').replace(PUA, '').trim() : s

async function extractPositionedText(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const items = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    for (const it of (await page.getTextContent()).items) {
      if (!it.str.trim()) continue
      items.push({ x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), page: p, str: it.str.normalize('NFC') })
    }
  }
  items.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)
  return items
}
function buildLogicalLines(items) {
  const rows = []; let curY = null, cur = []
  for (const it of items) {
    if (curY === null || Math.abs(it.y - curY) > 3 || (cur.length && cur[0].page !== it.page)) {
      if (cur.length) rows.push(cur); cur = [it]; curY = it.y
    } else cur.push(it)
  }
  if (cur.length) rows.push(cur)
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
  let optX = null
  const groups = []; let curY = null, cur = []
  for (const it of items) {
    if (curY === null || Math.abs(it.y - curY) > 3) { if (cur.length) groups.push(cur); cur = [it]; curY = it.y }
    else cur.push(it)
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
      const full = g.map(it => it.text).join(''); const x = g[0].x
      if (opts.length && optX != null && x > optX + 9) opts[opts.length - 1] += full
      else { if (optX == null) optX = x; opts.push(full) }
    }
  }
  return opts
}
function parseQuestions(lines) {
  const filtered = lines.filter(l => {
    const t = l.text
    if (/^(代號|類\s*科|科\s*目|考試|頁次|等\s*別|本試題|本科目|座號|※|禁止|共\d+題|請以|不必|不得|說明|一、|二、|三、|甲、|乙、|類科組別)/.test(t)) return false
    if (/^\d+－\d+$/.test(t)) return false
    return true
  })
  const qStarts = []; let expect = 1
  for (let i = 0; i < filtered.length; i++) {
    const line = filtered[i]
    if (line.x > 62) continue
    const m = line.text.match(/^(\d{1,2})(.*)$/)
    if (!m || !m[2]) continue
    const num = parseInt(m[1]); const rest = m[2]
    if (num < expect || num > expect + 4) continue
    if (/^[\d.．、]/.test(rest) && num !== expect) continue
    if (/^年\s*(第|公務|專門|國家|特種)/.test(rest)) continue
    qStarts.push({ idx: i, number: num }); expect = num + 1
  }
  const questions = []
  for (let qi = 0; qi < qStarts.length; qi++) {
    const start = qStarts[qi].idx
    const end = qi + 1 < qStarts.length ? qStarts[qi + 1].idx : filtered.length
    const num = qStarts[qi].number
    const block = filtered.slice(start, end)
    const stemText = block[0].text.slice(String(num).length).trim()
    const rest = block.slice(1)
    let stemEndIdx = 0
    let ended = /[？：︰?]/.test(stemText)
    if (!ended) for (let ri = 0; ri < rest.length; ri++) { if (/[？：︰?]/.test(rest[ri].text)) { stemEndIdx = ri + 1; break } }
    const stemParts = [stemText]
    for (let ri = 0; ri < stemEndIdx; ri++) stemParts.push(rest[ri].text)
    const opts = extractOptions(rest.slice(stemEndIdx))
    if (opts.length >= 2) {
      const options = {}; const labels = ['A', 'B', 'C', 'D']
      for (let oi = 0; oi < Math.min(opts.length, 4); oi++) options[labels[oi]] = clean(opts[oi])
      questions.push({ number: num, question: clean(stemParts.join(' ').trim()), options })
    }
  }
  return questions
}
async function parseAnswers(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const items = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    for (const it of (await page.getTextContent()).items) {
      if (!it.str.trim()) continue
      items.push({ x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), str: it.str.trim() })
    }
  }
  const answers = {}
  const qItems = items.filter(it => /^第\d{1,3}題$/.test(it.str))
  const aItems = items.filter(it => /^[ABCDE]$/.test(it.str))
  for (const q of qItems) {
    const num = parseInt(q.str.match(/^第(\d+)題$/)[1])
    let best = null, bestDy = Infinity
    for (const a of aItems) {
      if (Math.abs(a.x - q.x) > 18) continue
      const dy = q.y - a.y
      if (dy > 0 && dy < 34 && dy < bestDy) { bestDy = dy; best = a }
    }
    if (best) answers[num] = best.str
  }
  return answers
}
async function parseQuestionsAny(buf) {
  let qs = parseQuestions(buildLogicalLines(await extractPositionedText(buf)))
  if (qs.length < 20 && columnParser) {
    try {
      const cp = await columnParser.parseColumnAware(buf)
      const nums = Object.keys(cp).map(Number).sort((a, b) => a - b)
      if (nums.length > qs.length) qs = nums.map(n => ({ number: n, question: clean(cp[n].question),
        options: { A: clean(cp[n].options.A), B: clean(cp[n].options.B), C: clean(cp[n].options.C), D: clean(cp[n].options.D) } }))
    } catch {}
  }
  return qs
}
async function parseAnswersAny(buf) {
  let a = await parseAnswers(buf)
  if (Object.keys(a).length < 10 && columnParser) {
    try { const ta = columnParser.parseAnswersText((await pdfParse(buf)).text.normalize('NFC')); if (Object.keys(ta).length > Object.keys(a).length) a = ta } catch {}
  }
  if (Object.keys(a).length < 10 && columnParser) {
    try { const ca = await columnParser.parseAnswersColumnAware(buf); if (Object.keys(ca).length > Object.keys(a).length) a = ca } catch {}
  }
  return a
}

// ── TARGETS ──────────────────────────────────────────────────────────────
const TARGETS = [
  { file: 'questions-nursing.json', verify: '護理師', code: '102110', c: '109', s: '0107',
    roc_year: '102', session: '第二次', subject: '基礎醫學', subject_tag: 'basic_medicine', subject_name: '基礎醫學', stage_id: 0 },
]

async function main() {
  for (const t of TARGETS) {
    console.log(`\n── ${t.file} ${t.roc_year}${t.session} ${t.subject} (code=${t.code} c=${t.c} s=${t.s}) ──`)
    const fp = path.join(__dirname, '..', t.file)
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
    const arr = data.questions || data
    const seen = new Set(arr.map(q => `${q.exam_code}_${q.subject}_${q.number}`))
    const numIds = arr.map(q => Number(q.id)).filter(Number.isFinite)
    let nextId = (numIds.length ? Math.max(...numIds) : 0) + 1

    let qBuf, aBuf
    try { qBuf = await fetchPdf(`${BASE}?t=Q&code=${t.code}&c=${t.c}&s=${t.s}&q=1`) }
    catch (e) { console.log(`  ✗ Q PDF: ${e.message}`); continue }
    try { aBuf = await fetchPdf(`${BASE}?t=S&code=${t.code}&c=${t.c}&s=${t.s}&q=1`) }
    catch (e) { console.log(`  ⚠ 無答案 PDF: ${e.message}`); aBuf = null }

    const { text } = await pdfParse(qBuf)
    if (!text.normalize('NFC').slice(0, 500).includes(t.verify)) {
      console.log(`  ✗ PDF 類科不符（找不到「${t.verify}」）— 中止，不寫入`); continue
    }
    const parsed = await parseQuestionsAny(qBuf)
    const answers = aBuf ? await parseAnswersAny(aBuf) : {}
    let kept = 0
    const added = []
    for (const q of parsed) {
      const ans = answers[q.number]
      if (!ans || !/^[ABCD]$/.test(ans)) continue
      const o = q.options
      if (!o.A || !o.B || !o.C || !o.D) continue
      const key = `${t.code}_${t.subject}_${q.number}`
      if (seen.has(key)) continue
      seen.add(key)
      added.push({ id: nextId++, roc_year: t.roc_year, session: t.session, exam_code: t.code,
        subject: t.subject, subject_tag: t.subject_tag, subject_name: t.subject_name, stage_id: t.stage_id,
        number: q.number, question: q.question, options: { A: o.A, B: o.B, C: o.C, D: o.D }, answer: ans, explanation: '' })
      kept++
    }
    console.log(`  解析 ${parsed.length} / 答案 ${Object.keys(answers).length} / 採用 ${kept}`)
    if (kept) {
      arr.push(...added)
      if (data.total !== undefined) data.total = arr.length
      fs.writeFileSync(fp, JSON.stringify(data, null, 2) + '\n')
      console.log(`  ✅ 寫入 ${kept} 題 → ${t.file}`)
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
