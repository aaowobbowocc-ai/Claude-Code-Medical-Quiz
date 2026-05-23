#!/usr/bin/env node
/**
 * Scrape 關務特考三等 國文（測驗）missing papers: 104050, 106050, 110050.
 * 110050 already has Q1-9; we backfill Q10 (fill-gap). 104/106 entirely missing.
 *
 * Format (verified by probe 2026-05-23):
 *   - Question number: plain digit on its own item at low x (varies per year:
 *     104→x≈40, 106→x≈70, 110→x≈51) at the start of the question row.
 *   - Stem: plain text at higher x (≈ +20) on the same and following rows.
 *   - Option marker: PUA glyph at left margin of option region, option text
 *     follows immediately to the right. Multi-column layouts (2-col / 4-col)
 *     for short options.
 *
 * Parser strategy mirrors scrape-police-chinese-105-107.js: row-based walk
 * where the first PUA glyph in a row opens a new option, plain text after
 * appends to the current option. The leading digit on a question-start row
 * is stripped from the stem.
 *
 * c=101 s=0101 for all three years (verified). Common subject across
 * 關務人員 + 身心障礙人員 + 國軍轉任 — header check accepts 關務人員.
 * Idempotent via (exam_code, subject_tag, number) key.
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
const PUA_RE = new RegExp('[\\uE000-\\uF8FF]', 'g')
const stripPUA = s => (typeof s === 'string' ? s.replace(PUA_RE, '') : s)
const isPUA = s => stripPUA(s).trim() === ''

const SESSIONS = [
  { year: '104', code: '104050' },
  { year: '106', code: '106050' },
  { year: '110', code: '110050' },
]
const C = '101', S = '0101', EXPECT_Q = 10

const HEADER_RE = /（?請?接?背面）?|（正面）|代號[：:]|頁次|^\d{4,5}\s*[-－]\s*\d{4,5}|年公務人員特種考試|年國軍上校以上|年特種考試|考試試題|^考\s*試\s*別|^等\s*別|^類\s*科|^科\s*目[：:]|考試時間|座號|全一張|※|禁止使用電子計算|本試題為單一選擇題|本測驗試題為單一選擇題|複選作答者|每題.*分.*鉛筆|須用.*2B.*鉛筆|乙、測驗部分|甲、作文|甲、申論|請以藍|不得於試卷|^共\s*\d+\s*題/

async function extractItems(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const items = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    for (const it of (await page.getTextContent()).items) {
      if (!it.str.trim()) continue
      items.push({ x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), page: p, str: it.str })
    }
  }
  items.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)
  return items
}

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

function parseQuestions(items) {
  const rows = buildRows(items)
  // MCQ region begins after the 乙、測驗部分 line
  const startIdx = rows.findIndex(r => /^乙、?\s*測驗部分/.test(r.text))
  if (startIdx < 0) throw new Error('找不到「乙、測驗部分」段落')
  // Drop everything at/above 科目: line on pages > 1 (repeated exam header)
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

  // Question-start row: leftmost part is a bare digit equal to expectedNext
  // (covers 104 x≈40, 106 x≈70, 110 x≈51 since the digit is always the
  // leftmost item with text content much shorter than the stem column).
  const isQStart = (r, expect) => {
    const p0 = r.parts[0]
    return !isPUA(p0.str) && /^\d{1,2}$/.test(p0.str.trim()) && parseInt(p0.str) === expect
  }
  const qIdxs = []
  let expect = 1
  for (let i = 0; i < region.length; i++) {
    if (isQStart(region[i], expect)) { qIdxs.push(i); expect++ }
  }

  const out = []
  for (let qi = 0; qi < qIdxs.length; qi++) {
    const start = qIdxs[qi]
    const end = qi + 1 < qIdxs.length ? qIdxs[qi + 1] : region.length
    const block = region.slice(start, end)

    // First option row = first row where the leading non-digit part is PUA
    const optStart = block.findIndex((r, i) => {
      if (i === 0) {
        return false
      }
      return isPUA(r.parts[0].str)
    })
    if (optStart < 0) {
      if (process.env.DEBUG_PARSE) {
        console.log(`   DBG Q${qi+1} block len ${block.length}`)
        block.forEach((r, i) => console.log(`     ${i} p0.isPUA=${isPUA(r.parts[0].str)} p0=${JSON.stringify(r.parts[0].str.slice(0,8))} text=${r.text.slice(0,40)}`))
      }
      out.push({ number: qi + 1, bad: 'no-options' }); continue
    }

    // Stem: collect non-PUA, non-leading-digit text from start row + intermediate rows
    const stemRows = block.slice(0, optStart)
    const stemParts = []
    for (let ri = 0; ri < stemRows.length; ri++) {
      for (let pi = 0; pi < stemRows[ri].parts.length; pi++) {
        const p = stemRows[ri].parts[pi]
        if (isPUA(p.str)) continue
        // drop the leading question-number digit on the very first row
        if (ri === 0 && pi === 0 && /^\d{1,2}$/.test(p.str.trim())) continue
        stemParts.push(p.str)
      }
    }
    const stemText = stripPUA(stemParts.join('')).trim()

    // Determine option-text x: x of the first text part following the first
    // PUA in the option region. Used to distinguish option continuation
    // (x ≈ optTextX) from a shared passage that follows the question
    // (x ≈ stem column, well below optTextX).
    let optTextX = null
    {
      const r0 = block[optStart]
      for (let pi = 0; pi < r0.parts.length - 1; pi++) {
        if (isPUA(r0.parts[pi].str) && !isPUA(r0.parts[pi + 1].str)) {
          optTextX = r0.parts[pi + 1].x; break
        }
      }
    }

    // Option region: walk rows; PUA opens a new option, text appends to current.
    // Once 4 options are collected, treat further stem-x rows as a trailing
    // passage that belongs to the next question (shared passage group).
    const opts = []
    let trailingPassage = ''
    for (const r of block.slice(optStart)) {
      const rowHasPUA = r.parts.some(p => isPUA(p.str))
      if (opts.length >= 4 && !rowHasPUA) {
        const leadX = r.parts.find(p => !isPUA(p.str))?.x
        if (optTextX !== null && leadX !== undefined && leadX < optTextX - 5) {
          // passage row (stem column)
          trailingPassage += r.parts.filter(p => !isPUA(p.str)).map(p => p.str).join('')
          continue
        }
      }
      for (const p of r.parts) {
        if (isPUA(p.str)) {
          opts.push('')
        } else if (opts.length) {
          opts[opts.length - 1] += p.str
        }
      }
    }
    const cleaned = opts.map(o => stripPUA(o).trim()).filter((_, i) => i < 4)
    out.push({ number: qi + 1, question: stemText, options: cleaned, optCount: opts.length, trailingPassage: stripPUA(trailingPassage).trim() })
  }
  // Shared-passage handling: trailing passage harvested from question N belongs
  // to the start of question N+1 (the next question in the group).
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i].trailingPassage && !out[i].bad && !out[i + 1].bad) {
      out[i + 1].question = out[i].trailingPassage + out[i + 1].question
    }
  }
  return out
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
  if (Object.keys(answers).length >= 5) return answers
  // Fallback: fullwidth or half-width ABCD strings
  const { text } = await pdfParse(buf)
  const t = text.normalize('NFC')
  const fw = /答案\s*([ＡＢＣＤ]+)/g
  let m, n = 1
  while ((m = fw.exec(t)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) answers[n++] = k
    }
  }
  return answers
}

async function main() {
  const fp = path.join(__dirname, '..', 'questions-customs.json')
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
  const arr = data.questions || data
  const seen = new Set(arr.map(q => `${q.exam_code}_${q.subject_tag}_${q.number}`))
  let nextId = arr.reduce((m, q) => Math.max(m, +q.id || 0), 0) + 1
  const added = []

  for (const sess of SESSIONS) {
    console.log(`\n── ${sess.year} 國文（測驗）(code=${sess.code} c=${C} s=${S}) ──`)
    let qBuf, aBuf
    try { qBuf = await fetchPdf(`${BASE}?t=Q&code=${sess.code}&c=${C}&s=${S}&q=1`) }
    catch (e) { console.log(`  ✗ Q PDF: ${e.message}`); continue }
    try { aBuf = await fetchPdf(`${BASE}?t=S&code=${sess.code}&c=${C}&s=${S}&q=1`) }
    catch (e) { console.log(`  ✗ S PDF: ${e.message}`); continue }

    const { text } = await pdfParse(qBuf)
    const head = text.normalize('NFC').slice(0, 500)
    if (!head.includes('關務人員') || !head.includes('國文')) {
      console.log('  ✗ header 不符（缺「關務人員」或「國文」）— 中止'); continue
    }

    const items = await extractItems(qBuf)
    const questions = parseQuestions(items)
    const answers = await parseAnswers(aBuf)
    console.log(`  解析 ${questions.length} / 答案 ${Object.keys(answers).length} （預期 ${EXPECT_Q}）`)

    let kept = 0, skipDup = 0
    for (const q of questions) {
      if (q.bad) { console.log(`  ⚠ Q${q.number}: ${q.bad}`); continue }
      if (q.optCount !== 4 || q.options.length !== 4 || q.options.some(o => !o)) {
        console.log(`  ⚠ Q${q.number}: 選項數=${q.optCount} → 跳過`); continue
      }
      const ans = answers[q.number]
      if (!ans || !/^[ABCD]$/.test(ans)) { console.log(`  ⚠ Q${q.number}: 無有效答案`); continue }
      const key = `${sess.code}_chinese_${q.number}`
      if (seen.has(key)) { skipDup++; continue }
      seen.add(key)
      added.push({
        id: nextId++, roc_year: sess.year, session: '第一次', exam_code: sess.code,
        subject: '國文（測驗）', subject_tag: 'chinese', subject_name: '國文（測驗）', stage_id: 0,
        number: q.number, question: q.question,
        options: { A: q.options[0], B: q.options[1], C: q.options[2], D: q.options[3] },
        answer: ans, explanation: '',
      })
      kept++
    }
    console.log(`  ✓ 新增 ${kept} 題（重複跳過 ${skipDup}）`)
    if (DRY) {
      for (const q of questions) {
        if (q.bad || q.optCount !== 4) continue
        console.log(`  [${q.number}] ${q.question.slice(0, 70)}  | ans=${answers[q.number]}`)
        q.options.forEach((o, i) => console.log(`      ${'ABCD'[i]}. ${o.slice(0, 70)}`))
      }
    }
    await sleep(400)
  }

  if (DRY) { console.log(`\n[dry-run] 可採用 ${added.length} 題，未寫入。`); return }
  if (!added.length) { console.log('\n(無新題可加入)'); return }
  arr.push(...added)
  data.total = arr.length
  fs.writeFileSync(fp, JSON.stringify(data, null, 2) + '\n')
  console.log(`\n✅ 寫入 ${added.length} 題 → questions-customs.json（total ${arr.length}）`)
}

main().catch(e => { console.error(e); process.exit(1) })
