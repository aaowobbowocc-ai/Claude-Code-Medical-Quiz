#!/usr/bin/env node
// Scrape 鐵路特考佐級 (Railway junior-level special exam) — 運輸營業 + 事務管理.
// 鐵路特考 was discontinued after 112 (台鐵 corporatised 2024). Historical bank
// 100-112, positioned as 台鐵招考 practice material.
//
// 類科 → c-code:  運輸營業 c=903 / 事務管理 c=901
// Papers (all pure MCQ, 佐級):
//   運輸營業: 國文 / 公民與英文 / 企業管理大意 / 鐵路運輸學大意
//   事務管理: 國文 / 公民與英文 / 事務管理大意 / 法學大意
// 國文 has 複選題 (Q36-45, options A-E) — we keep only 單選 (single A-D answer).
//
// Session/class/subject codes per year: scripts/_railway-map.json (probe-railway.js).
// Usage: node scripts/scrape-railway.js [--exam transport|admin] [--year 112]

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { fetchPdf } = require('./lib/pdf-fetcher')
const pdfjsLib = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')
const pdfParse = require('pdf-parse')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PUA_RE = new RegExp("[\uE000-\uF8FF]", "g")
// Old (100-105) PDFs use CJK Compatibility Ideographs (U+F900-FAFF, e.g. 路=U+F937).
// NFC canonical normalisation maps them to unified ideographs without touching
// fullwidth punctuation (that would be NFKC).
const stripPUA = s => typeof s === "string" ? s.normalize("NFC").replace(PUA_RE, "").trim() : s

// ── PDF text positioning (same approach as scrape-police4.js) ────────────
async function extractPositionedText(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const items = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    for (const it of content.items) {
      if (!it.str.trim()) continue
      items.push({ x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), page: p, str: it.str.normalize('NFC') })
    }
  }
  items.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)
  return items
}

function buildLogicalLines(items) {
  const rows = []
  let curY = null, cur = []
  for (const it of items) {
    if (curY === null || Math.abs(it.y - curY) > 3 || (cur.length && cur[0].page !== it.page)) {
      if (cur.length) rows.push(cur)
      cur = [it]; curY = it.y
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
  let optX = null   // established left-x of an option line (deeper x = wrap)
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
      // Each option occupies its own full-width line in 佐級 PDFs. Append a
      // line to the previous option only when it is clearly a wrap continuation
      // (indented deeper than the established option-start x).
      const full = g.map(it => it.text).join('')
      const x = g[0].x
      if (opts.length && optX != null && x > optX + 9) {
        opts[opts.length - 1] += full
      } else {
        if (optX == null) optX = x
        opts.push(full)
      }
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
  // Detect question anchors: a 1-2 digit number at x<62 followed by non-digit
  // text. Tolerate gaps (English cloze/passage questions whose number is not at
  // line start) — accept any number in [expect, expect+4] so one miss does not
  // abort the rest of the paper.
  const qStarts = []
  let expect = 1
  for (let i = 0; i < filtered.length; i++) {
    const line = filtered[i]
    if (line.x > 62) continue
    const m = line.text.match(/^(\d{1,2})(.*)$/)
    if (!m || !m[2]) continue
    const num = parseInt(m[1])
    const rest = m[2]
    if (num < expect || num > expect + 4) continue   // keep sequence monotonic
    // a digit right after the number is ambiguous ("162022年…") — only trust it
    // when the number is exactly the next expected one.
    if (/^[\d.．、]/.test(rest) && num !== expect) continue
    if (/^年\s*(第|公務|專門|國家|特種)/.test(rest)) continue
    qStarts.push({ idx: i, number: num })
    expect = num + 1
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
    if (!ended) {
      for (let ri = 0; ri < rest.length; ri++) {
        if (/[？：︰?]/.test(rest[ri].text)) { stemEndIdx = ri + 1; ended = true; break }
      }
    }
    const stemParts = [stemText]
    for (let ri = 0; ri < stemEndIdx; ri++) stemParts.push(rest[ri].text)
    const opts = extractOptions(rest.slice(stemEndIdx))
    if (opts.length >= 2) {
      const options = {}
      const labels = ['A', 'B', 'C', 'D']
      for (let oi = 0; oi < Math.min(opts.length, 4); oi++) options[labels[oi]] = stripPUA(opts[oi])
      questions.push({ number: num, question: stripPUA(stemParts.join(' ').trim()), options })
    }
  }
  return questions
}

// ── Answer PDF: positioned grid (第N題 → letter) ─────────────────────────
async function parseAnswers(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const items = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    for (const it of content.items) {
      if (!it.str.trim()) continue
      items.push({ x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), str: it.str.trim() })
    }
  }
  const answers = {}
  const qItems = items.filter(it => /^第\d{1,3}題$/.test(it.str))
  // each answer cell: a single A-E letter (E appears in 複選 — kept raw, filtered later)
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

// ── Column-aware fallback for old (100-105) PDFs without ABCD markers ────
let columnParser = null
try { columnParser = require('./lib/moex-column-parser') } catch {}

async function parseQuestionsAny(buf) {
  const items = await extractPositionedText(buf)
  let qs = parseQuestions(buildLogicalLines(items))
  if (qs.length < 20 && columnParser) {
    try {
      const cp = await columnParser.parseColumnAware(buf)
      const nums = Object.keys(cp).map(Number).sort((a, b) => a - b)
      if (nums.length > qs.length) {
        qs = nums.map(n => ({ number: n, question: stripPUA(cp[n].question), options: {
          A: stripPUA(cp[n].options.A), B: stripPUA(cp[n].options.B),
          C: stripPUA(cp[n].options.C), D: stripPUA(cp[n].options.D),
        } }))
      }
    } catch {}
  }
  return qs
}

async function parseAnswersAny(buf) {
  let a = await parseAnswers(buf)                       // 第N題 grid (103+)
  if (Object.keys(a).length < 10 && columnParser) {
    // continuous "答案ABCD…" format (100-102 half-width / older full-width)
    try {
      const { text } = await pdfParse(buf)
      const ta = columnParser.parseAnswersText(text.normalize('NFC'))
      if (Object.keys(ta).length > Object.keys(a).length) a = ta
    } catch {}
  }
  if (Object.keys(a).length < 10 && columnParser) {
    try {
      const ca = await columnParser.parseAnswersColumnAware(buf)
      if (Object.keys(ca).length > Object.keys(a).length) a = ca
    } catch {}
  }
  return a
}

// ── Subject resolution ───────────────────────────────────────────────────
function resolveS(subjects, keyword) {
  for (const [s, name] of Object.entries(subjects)) {
    if (name.includes(keyword)) return s
  }
  return null
}

// 類科 → ordered papers. matchKey resolves the per-year s-code.
const EXAMS = {
  transport: {
    file: 'questions-railway-transport.json',
    cKey: 'transport',
    papers: [
      { subject: '國文', tag: 'chinese', match: '國文', singleChoiceOnly: true },
      { subject: '公民與英文', tag: 'civics_english', match: '公民' },
      { subject: '企業管理大意', tag: 'business_mgmt', match: '企業管理' },
      { subject: '鐵路運輸學大意', tag: 'transport_studies', match: '運輸學' },
    ],
  },
  admin: {
    file: 'questions-railway-admin.json',
    cKey: 'admin',
    papers: [
      { subject: '國文', tag: 'chinese', match: '國文', singleChoiceOnly: true },
      { subject: '公民與英文', tag: 'civics_english', match: '公民' },
      { subject: '事務管理大意', tag: 'office_mgmt', match: '事務管理' },
      { subject: '法學大意', tag: 'law_basics', match: '法學' },
    ],
  },
}

function atomicWrite(p, obj) {
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, p)
}

async function scrapeExam(examKey, map, yearFilter) {
  const def = EXAMS[examKey]
  const file = path.join(__dirname, '..', def.file)
  let data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : { total: 0, questions: [] }
  const seen = new Set(data.questions.map(q => `${q.exam_code}_${q.subject_tag}_${q.number}`))
  let nextId = data.questions.length ? Math.max(...data.questions.map(q => q.id || 0)) + 1 : 1
  const added = []

  for (const roc of Object.keys(map).sort()) {
    if (yearFilter && roc !== yearFilter) continue
    const ym = map[roc]
    const cls = ym[def.cKey]
    if (!cls) { console.log(`  ${roc}: no ${examKey} 類科`); continue }
    console.log(`\n── ${roc} ${ym.sessionCode} c=${cls.c} ──`)

    for (const paper of def.papers) {
      const s = resolveS(cls.subjects, paper.match)
      if (!s) { console.log(`  ✗ ${paper.subject}: no s-code`); continue }
      const qUrl = `${BASE}?t=Q&code=${ym.sessionCode}&c=${cls.c}&s=${s}&q=1`
      const aUrl = `${BASE}?t=S&code=${ym.sessionCode}&c=${cls.c}&s=${s}&q=1`
      let qBuf, aBuf
      try { qBuf = await fetchPdf(qUrl) } catch (e) { console.log(`  ✗ ${paper.subject} (s=${s}): Q ${e.message}`); continue }
      try { aBuf = await fetchPdf(aUrl) } catch (e) { console.log(`  ⚠ ${paper.subject} (s=${s}): no answers ${e.message}`); aBuf = null }

      // verify exam name
      try {
        const { text } = await pdfParse(qBuf)
        if (!/鐵路/.test(text.normalize('NFC').slice(0, 600))) {
          console.log(`  ✗ ${paper.subject} (s=${s}): PDF not 鐵路 — skip`)
          if (process.env.DEBUG) console.log(`     head: ${JSON.stringify(text.slice(0, 120))}`)
          continue
        }
      } catch (e) { if (process.env.DEBUG) console.log(`     pdfParse err: ${e.message}`) }

      const parsed = await parseQuestionsAny(qBuf)
      const answers = aBuf ? await parseAnswersAny(aBuf) : {}

      let kept = 0, dropped = 0
      for (const q of parsed) {
        const ans = answers[q.number]
        if (!ans || !/^[ABCD]$/.test(ans)) { dropped++; continue }  // drop 複選 / unanswered
        const o = q.options
        if (!o.A || !o.B || !o.C || !o.D) { dropped++; continue }
        const key = `${ym.sessionCode}_${paper.tag}_${q.number}`
        if (seen.has(key)) continue
        seen.add(key)
        added.push({
          id: nextId++, roc_year: roc, session: '第一次', exam_code: ym.sessionCode,
          subject: paper.subject, subject_tag: paper.tag, subject_name: paper.subject,
          stage_id: 0, number: q.number,
          question: q.question, options: { A: o.A, B: o.B, C: o.C, D: o.D },
          answer: ans, explanation: '',
        })
        kept++
      }
      console.log(`  ✓ ${paper.subject} (s=${s}): ${kept} kept / ${parsed.length} parsed / ${Object.keys(answers).length} answers (dropped ${dropped})`)
      if (process.env.DEBUG) {
        const got = new Set(parsed.map(q => q.number))
        const maxN = Math.max(...Object.keys(answers).map(Number), 0)
        const miss = []
        for (let n = 1; n <= maxN; n++) if (!got.has(n)) miss.push(n)
        if (miss.length) console.log(`     missing #: ${miss.join(',')}`)
      }
      await sleep(450)
    }
  }

  if (!added.length) { console.log('\n(nothing new)'); return }
  data.questions.push(...added)
  data.total = data.questions.length
  atomicWrite(file, data)
  console.log(`\n✅ ${examKey}: +${added.length} → ${data.questions.length} total`)
}

async function main() {
  const args = process.argv.slice(2)
  const examArg = args.includes('--exam') ? args[args.indexOf('--exam') + 1] : null
  const yearArg = args.includes('--year') ? args[args.indexOf('--year') + 1] : null
  const map = JSON.parse(fs.readFileSync(path.join(__dirname, '_railway-map.json'), 'utf-8'))
  const exams = examArg ? [examArg] : ['transport', 'admin']
  for (const e of exams) {
    if (!EXAMS[e]) { console.error(`unknown exam: ${e}`); process.exit(1) }
    console.log(`\n═══════ ${e} ═══════`)
    await scrapeExam(e, map, yearArg)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
