#!/usr/bin/env node
/**
 * Scrape 一般警察特考三等 國文 105-107 (測驗部分, 10 MCQ/paper).
 *
 * Why a dedicated script: 105-107 國文 PDFs render question numbers and option
 * labels (A/B/C/D) as PUA glyphs (no visible digits / no "(A)" markers). The
 * generic position parser (scrape-police.js) keys on `startsWith(number)` and
 * the column parser (moex-column-parser.js findAnchors) keys on `^\d+$` anchors
 * — both fail here. This parser uses PUA-marker x-position instead:
 *   x < 100  → question-number glyph (starts a question)
 *   x >= 100 → option-label glyph    (starts an option)
 *
 * code=105070/106070/107070, c=301, s=0102 (國文, shared 警察+一般警察+鐵路).
 * Idempotent: skips (exam_code, tag, number) already present.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { fetchPdf } = require('./lib/pdf-fetcher')
const pdfjsLib = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')
const pdfParse = require('pdf-parse')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const DRY = process.argv.includes('--dry-run')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const stripPUA = s => (typeof s === 'string' ? s.replace(/[-]/g, '') : s)
const isPUA = s => stripPUA(s).trim() === '' // glyph that is ONLY PUA chars

const SESSIONS = [
  { year: '105', code: '105070' },
  { year: '106', code: '106070' },
  { year: '107', code: '107070' },
]
const C = '301', S = '0102', EXPECT_Q = 10

const HEADER_RE = /（?請?接?背面）?|（正面）|代號[：:]|^\d{4,5}-\d{4,5}|年公務人員特種考試|年特種考試交通|考試試題|^考試別|^等別|^類科別|^科目[：:]|考試時間|座號|全一張|※|禁止使用電子計算|本試題為單一選擇題|複選作答者|每題.*分.*鉛筆|須用2B鉛筆|乙、測驗部分|甲、作文/

async function extractItems(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const items = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    for (const it of (await page.getTextContent()).items) {
      if (!it.str.trim()) continue // skips whitespace-only; keeps PUA glyphs
      items.push({ x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), page: p, str: it.str })
    }
  }
  items.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)
  return items
}

// group sorted items into rows (same page, y within 3px)
function buildRows(items) {
  const rows = []
  let cur = null
  for (const it of items) {
    if (!cur || cur.page !== it.page || Math.abs(cur.y - it.y) > 3) {
      cur = { page: it.page, y: it.y, parts: [it] }
      rows.push(cur)
    } else cur.parts.push(it)
  }
  for (const r of rows) {
    r.parts.sort((a, b) => a.x - b.x)
    r.text = stripPUA(r.parts.map(p => p.str).join('')).trim()
  }
  return rows
}

function parseQuestions(buf, items) {
  const rows = buildRows(items)
  // MCQ region begins at the row containing 乙、測驗部分
  const startIdx = rows.findIndex(r => r.text.includes('測驗部分'))
  if (startIdx < 0) throw new Error('找不到「測驗部分」段落')
  // On pages 2+, the whole exam header is reprinted at the top. Its last line
  // is "科目：國文…"; anything at or above it on that page is header noise
  // (incl. orphan wraps like "任公務人員考試"). Record the cutoff y per page.
  const subjY = {}
  for (const r of rows) {
    if (r.page > 1 && subjY[r.page] === undefined && /^科\s*目\s*[：:]/.test(r.text)) subjY[r.page] = r.y
  }
  const region = rows.slice(startIdx + 1).filter(r => {
    if (!r.text) return false
    if (HEADER_RE.test(r.text)) return false
    if (r.page > 1 && subjY[r.page] !== undefined && r.y >= subjY[r.page]) return false
    return true
  })

  // a question-start row has a PUA glyph at x < 100 as its first part
  const isQStart = r => isPUA(r.parts[0].str) && r.parts[0].x < 100
  const qIdxs = region.map((r, i) => (isQStart(r) ? i : -1)).filter(i => i >= 0)

  const questions = []
  for (let qi = 0; qi < qIdxs.length; qi++) {
    const start = qIdxs[qi]
    const end = qi + 1 < qIdxs.length ? qIdxs[qi + 1] : region.length
    const block = region.slice(start, end)

    // first option row = first row whose leading part is a PUA glyph at x >= 100
    const optStart = block.findIndex(r => isPUA(r.parts[0].str) && r.parts[0].x >= 100)
    if (optStart < 0) { questions.push({ number: qi + 1, bad: 'no-options' }); continue }

    const stemRows = block.slice(0, optStart)
    const stemText = stripPUA(
      stemRows.flatMap(r => r.parts.filter(p => !isPUA(p.str)).map(p => p.str)).join('')
    ).trim()

    // walk option region; each PUA glyph (x>=100) opens the next option
    const opts = []
    for (const r of block.slice(optStart)) {
      for (const p of r.parts) {
        if (isPUA(p.str)) {
          if (p.x >= 100) opts.push('')          // new option label
          // PUA at x<100 shouldn't appear here (those bound questions)
        } else if (opts.length) {
          opts[opts.length - 1] += p.str
        }
      }
    }
    const cleaned = opts.map(o => stripPUA(o).trim()).filter((_, i) => i < 4)
    questions.push({
      number: qi + 1,
      question: stemText,
      options: cleaned,
      optCount: opts.length,
    })
  }
  return questions
}

// answer PDF: grid of 第N題 headers with answer letters below — pair by x
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
  const aItems = items.filter(it => /^[ABCD]$/.test(it.str))
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

async function main() {
  const fp = path.join(__dirname, '..', 'questions-police.json')
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
  const arr = data.questions || data
  const seen = new Set(arr.map(q => `${q.exam_code}_${q.subject_tag}_${q.number}`))
  let nextId = arr.reduce((m, q) => Math.max(m, +q.id || 0), 0) + 1
  const added = []

  for (const sess of SESSIONS) {
    console.log(`\n── ${sess.year} 國文 (code=${sess.code} c=${C} s=${S}) ──`)
    let qBuf, aBuf
    try { qBuf = await fetchPdf(`${BASE}?t=Q&code=${sess.code}&c=${C}&s=${S}&q=1`) }
    catch (e) { console.log(`  ✗ Q PDF: ${e.message}`); continue }
    try { aBuf = await fetchPdf(`${BASE}?t=S&code=${sess.code}&c=${C}&s=${S}&q=1`) }
    catch (e) { console.log(`  ✗ S PDF: ${e.message}`); continue }

    const { text } = await pdfParse(qBuf)
    const head = text.normalize('NFC').slice(0, 400)
    if (!head.includes('一般警察人員') || !head.includes('國文')) {
      console.log('  ✗ header 不符（缺「一般警察人員」或「國文」）— 中止，不寫入'); continue
    }

    const items = await extractItems(qBuf)
    const questions = parseQuestions(qBuf, items)
    const answers = await parseAnswers(aBuf)
    console.log(`  解析題數 ${questions.length} / 答案 ${Object.keys(answers).length}（預期 ${EXPECT_Q}）`)

    let kept = 0
    for (const q of questions) {
      if (q.bad) { console.log(`  ⚠ Q${q.number}: ${q.bad}`); continue }
      if (q.optCount !== 4 || q.options.length !== 4 || q.options.some(o => !o)) {
        console.log(`  ⚠ Q${q.number}: 選項數=${q.optCount} → 跳過`); continue
      }
      const ans = answers[q.number]
      if (!ans || !/^[ABCD]$/.test(ans)) { console.log(`  ⚠ Q${q.number}: 無有效答案`); continue }
      const key = `${sess.code}_chinese_${q.number}`
      if (seen.has(key)) continue
      seen.add(key)
      added.push({
        id: nextId++, roc_year: sess.year, session: '第一次', exam_code: sess.code,
        subject: '國文', subject_tag: 'chinese', subject_name: '國文', stage_id: 0,
        number: q.number, question: q.question,
        options: { A: q.options[0], B: q.options[1], C: q.options[2], D: q.options[3] },
        answer: ans, explanation: '',
      })
      kept++
    }
    console.log(`  ✓ 採用 ${kept} 題`)
    if (DRY) {
      for (const q of questions) {
        if (q.bad || q.optCount !== 4) continue
        console.log(`  [${q.number}] ${q.question.slice(0, 60)}  | ans=${answers[q.number]}`)
        q.options.forEach((o, i) => console.log(`      ${'ABCD'[i]}. ${o.slice(0, 70)}`))
      }
    }
    await sleep(400)
  }

  if (DRY) { console.log(`\n[dry-run] 共可採用 ${added.length} 題，未寫入。`); return }
  if (!added.length) { console.log('\n(無新題可加入)'); return }
  arr.push(...added)
  data.total = arr.length
  if (data.seo) {} // total handled at config level separately
  fs.writeFileSync(fp, JSON.stringify(data, null, 2) + '\n')
  console.log(`\n✅ 寫入 ${added.length} 題 → questions-police.json（total ${arr.length}）`)
}

main().catch(e => { console.error(e); process.exit(1) })
