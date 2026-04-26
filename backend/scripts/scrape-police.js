#!/usr/bin/env node
// Scrape 一般警察特考 MCQ subjects using pdfjs-dist position data
// Subjects: 行政學 (25Q) + 行政法 (25Q) — both mixed essay+MCQ
// Available: 113-114, c=301 (三等 行政警察人員)
// Note: Subject codes differ between years (行政學: 0301 in 113, 0304 in 114)

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { fetchPdf, cachedFetch, buildMoexUrl } = require('./lib/pdf-fetcher')
const https = require('https')
const pdfjsLib = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')
const pdfParse = require('pdf-parse')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'


async function extractPositionedText(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const allItems = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    for (const item of content.items) {
      if (!item.str.trim()) continue
      allItems.push({
        x: Math.round(item.transform[4]),
        y: Math.round(item.transform[5]),
        page: p,
        str: item.str,
      })
    }
  }
  allItems.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)
  return allItems
}

function buildLogicalLines(items) {
  const rows = []
  let currentY = null, currentRow = []

  for (const item of items) {
    if (currentY === null || Math.abs(item.y - currentY) > 3) {
      if (currentRow.length) rows.push(currentRow)
      currentRow = [item]
      currentY = item.y
    } else {
      currentRow.push(item)
    }
  }
  if (currentRow.length) rows.push(currentRow)

  const lines = []
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x)

    const gapIdxs = []
    for (let i = 1; i < row.length; i++) {
      const prevEnd = row[i - 1].x + row[i - 1].str.length * 11
      if (row[i].x - prevEnd > 30 || row[i].x - row[i - 1].x > 80) {
        gapIdxs.push(i)
      }
    }

    if (gapIdxs.length >= 3) {
      const breaks = [0, ...gapIdxs, row.length]
      for (let b = 0; b < breaks.length - 1; b++) {
        const chunk = row.slice(breaks[b], breaks[b + 1])
        const text = chunk.map(r => r.str).join('').trim()
        if (text) lines.push({ text, x: chunk[0].x, y: row[0].y, col: 'C' + b })
      }
    } else if (gapIdxs.length >= 1) {
      const left = row.slice(0, gapIdxs[0]).map(r => r.str).join('').trim()
      const right = row.slice(gapIdxs[0]).map(r => r.str).join('').trim()
      if (left) lines.push({ text: left, x: row[0].x, y: row[0].y, col: 'L' })
      if (right) lines.push({ text: right, x: row[gapIdxs[0]].x, y: row[0].y, col: 'R' })
    } else {
      const text = row.map(r => r.str).join('').trim()
      if (text) lines.push({ text, x: row[0].x, y: row[0].y, col: 'F' })
    }
  }
  return lines
}

function parseQuestions(lines) {
  const filtered = lines.filter(l => {
    const t = l.text
    if (/^(代號|類\s*科|科\s*目|考試|頁次|等\s*別|本試題|座號|※|禁止|本科目|須用|共\d+題|請以|不必|不得)/.test(t)) return false
    if (/^\d+－\d+$/.test(t)) return false
    if (/^頁次/.test(t)) return false
    return true
  })

  const qStarts = []
  let expectNext = 1
  for (let i = 0; i < filtered.length; i++) {
    const line = filtered[i]
    if (line.x > 60) continue
    const es = String(expectNext)
    if (line.text.startsWith(es)) {
      const rest = line.text.slice(es.length)
      if (rest.length === 0) continue
      const fullLeading = line.text.match(/^(\d+)/)[1]
      const fullNum = parseInt(fullLeading)
      if (fullNum !== expectNext) {
        if (/^年\s*(第|公務|專門|國家|特種)/.test(rest)) continue
      } else {
        if (/^年\s*(第|公務|專門|國家|特種)/.test(rest)) continue
      }
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

    const stemText = block[0].text.slice(String(num).length).trim()
    const restItems = block.slice(1)

    let stemEndIdx = 0
    let stemEnded = stemText.includes('？') || stemText.includes('：')
    if (!stemEnded) {
      for (let ri = 0; ri < restItems.length; ri++) {
        if (restItems[ri].text.includes('？') || restItems[ri].text.includes('：')) {
          stemEndIdx = ri + 1
          stemEnded = true
          break
        }
      }
    }

    const stemParts = [stemText]
    for (let ri = 0; ri < stemEndIdx; ri++) stemParts.push(restItems[ri].text)
    const optionItems = restItems.slice(stemEndIdx)
    const opts = extractOptions(optionItems)

    if (opts.length >= 2) {
      const options = {}
      const labels = ['A', 'B', 'C', 'D']
      for (let oi = 0; oi < Math.min(opts.length, 4); oi++) {
        options[labels[oi]] = opts[oi]
      }
      questions.push({ number: num, question: stemParts.join(' ').trim(), options })
    }
  }
  return questions
}

function extractOptions(items) {
  if (items.length === 0) return []

  const yGroups = []
  let curY = null, curGroup = []
  for (const item of items) {
    if (curY === null || Math.abs(item.y - curY) > 3) {
      if (curGroup.length) yGroups.push(curGroup)
      curGroup = [item]
      curY = item.y
    } else {
      curGroup.push(item)
    }
  }
  if (curGroup.length) yGroups.push(curGroup)

  const opts = []
  for (const group of yGroups) {
    group.sort((a, b) => a.x - b.x)
    const colTypes = new Set(group.map(it => it.col))

    if (colTypes.has('C0') || colTypes.has('C1') || colTypes.has('C2') || colTypes.has('C3')) {
      for (const item of group) opts.push(item.text)
    } else if (colTypes.has('L') && colTypes.has('R')) {
      const left = group.filter(it => it.col === 'L').map(it => it.text).join('')
      const right = group.filter(it => it.col === 'R').map(it => it.text).join('')
      opts.push(left)
      opts.push(right)
    } else {
      const fullText = group.map(it => it.text).join('')
      if (opts.length > 0 && group[0].x > 65 && group[0].col === 'F' && fullText.length < 25) {
        opts[opts.length - 1] += fullText
      } else {
        opts.push(fullText)
      }
    }
  }
  return opts
}

async function parseAnswers(buf) {
  // Use position-based extraction to correctly pair 第N題 with answer letters
  // The t=S PDF has a table: 題號 row (第1題 第2題 ...) then 答案 row (B D A ...)
  // pdf-parse garbles this; pdfjs-dist position data preserves column alignment
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const allItems = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    for (const item of content.items) {
      if (!item.str.trim()) continue
      allItems.push({
        x: Math.round(item.transform[4]),
        y: Math.round(item.transform[5]),
        str: item.str.trim(),
      })
    }
  }
  allItems.sort((a, b) => b.y - a.y || a.x - b.x)

  const answers = {}

  // Find 第N題 items and pair each with the answer letter directly below (same x, lower y)
  const qItems = allItems.filter(it => /^第\d{1,3}題$/.test(it.str))
  const ansItems = allItems.filter(it => /^[ABCD]$/.test(it.str))

  for (const qi of qItems) {
    const num = parseInt(qi.str.match(/^第(\d+)題$/)[1])
    // Find closest answer item with similar x (within 15px) and y below the question header
    let best = null, bestDist = Infinity
    for (const ai of ansItems) {
      if (Math.abs(ai.x - qi.x) > 15 && Math.abs(ai.x - qi.x - 12) > 15) continue
      const dy = qi.y - ai.y
      if (dy > 0 && dy < 30 && dy < bestDist) {
        bestDist = dy
        best = ai
      }
    }
    if (best) answers[num] = best.str
  }

  if (Object.keys(answers).length >= 5) return answers

  // Fallback: try fullwidth format from pdf-parse
  const { text } = await pdfParse(buf)
  const fw = /答案\s*([ＡＢＣＤ]+)/g
  let m, n = 1
  while ((m = fw.exec(text)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) answers[n++] = k
    }
  }
  return answers
}

const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s
const sleep = ms => new Promise(r => setTimeout(r, ms))

function atomicWrite(p, obj) {
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, p)
}

async function main() {
  const SESSIONS = [
    // 070 series (一般警察+退除役+鐵路 combined exam)
    { year: '108', code: '108070', session: '第一次' },
    { year: '109', code: '109070', session: '第一次' },
    { year: '110', code: '110070', session: '第一次' },
    { year: '111', code: '111070', session: '第一次' },
    { year: '112', code: '112070', session: '第一次' },
    // 060 series (一般警察 standalone from 113+)
    { year: '113', code: '113060', session: '第一次' },
    { year: '114', code: '114060', session: '第一次' },
  ]
  const SUBJECTS = [
    // 行政學: s=0301 for 070 series (108-112) and 060/113, s=0304 for 060/114
    { c: '301', s: '0301', name: '行政學', tag: 'admin_studies', expectedQ: 25, mixedEssay: true, onlyYears: ['108','109','110','111','112','113'] },
    { c: '301', s: '0304', name: '行政學', tag: 'admin_studies', expectedQ: 25, mixedEssay: true, onlyYears: ['114'] },
    // 行政法: s=0402 for 109/070, s=0403 for 060 series (113-114)
    { c: '301', s: '0402', name: '行政法', tag: 'admin_law', expectedQ: 25, mixedEssay: true, onlyYears: ['109'] },
    { c: '301', s: '0403', name: '行政法', tag: 'admin_law', expectedQ: 25, mixedEssay: true, onlyYears: ['113','114'] },
  ]
  const file = path.join(__dirname, '..', 'questions-police.json')

  let data
  if (fs.existsSync(file)) {
    data = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } else {
    data = { total: 0, questions: [] }
  }
  const existingKey = new Set(data.questions.map(q => `${q.exam_code}_${q.number}_${q.subject_tag}`))
  let nextId = data.questions.length > 0 ? Math.max(...data.questions.map(q => q.id || 0)) + 1 : 1
  const added = []

  for (const sess of SESSIONS) {
    console.log(`\n--- ${sess.year} ${sess.session} (${sess.code}) ---`)
    for (const sub of SUBJECTS) {
      if (sub.onlyYears && !sub.onlyYears.includes(sess.year)) continue
      const qUrl = `${BASE}?t=Q&code=${sess.code}&c=${sub.c}&s=${sub.s}&q=1`
      const aUrl = `${BASE}?t=S&code=${sess.code}&c=${sub.c}&s=${sub.s}&q=1`
      let qBuf, aBuf

      try { qBuf = await fetchPdf(qUrl) } catch (e) {
        console.log(`  ✗ ${sub.name}: ${e.message}`); continue
      }
      try { aBuf = await fetchPdf(aUrl) } catch (e) {
        console.log(`  ⚠ ${sub.name} no answers: ${e.message}`); aBuf = null
      }

      // Extract with position data
      let posItems = await extractPositionedText(qBuf)
      // Skip to 選擇題 section for mixed essay+MCQ
      if (sub.mixedEssay) {
        const mcqIdx = posItems.findIndex(it => it.str.includes('選擇題'))
        if (mcqIdx >= 0) {
          posItems = posItems.slice(mcqIdx)
        } else {
          console.log(`  ⚠ ${sub.name}: no 選擇題 section found`); continue
        }
      }

      const logLines = buildLogicalLines(posItems)
      const parsed = parseQuestions(logLines)
      const answers = aBuf ? await parseAnswers(aBuf) : {}

      console.log(`  ✓ ${sub.tag}: ${parsed.length} Q / ${Object.keys(answers).length} A (expected ${sub.expectedQ})`)

      for (const q of parsed) {
        const ans = answers[q.number]
        if (!ans) continue
        const key = `${sess.code}_${q.number}_${sub.tag}`
        if (existingKey.has(key)) continue
        const cleanOpts = {}
        for (const k of ['A', 'B', 'C', 'D']) cleanOpts[k] = stripPUA(q.options[k] || '')
        const entry = {
          id: nextId++, roc_year: sess.year, session: sess.session, exam_code: sess.code,
          subject: sub.name, subject_tag: sub.tag, subject_name: sub.name,
          stage_id: 0, number: q.number,
          question: stripPUA(q.question), options: cleanOpts,
          answer: ans, explanation: '',
        }
        added.push(entry)
      }
      await sleep(400)
    }
  }

  if (added.length === 0) { console.log('\n(nothing to add)'); return }
  data.questions.push(...added)
  data.total = data.questions.length
  atomicWrite(file, data)
  console.log(`\n✅ +${added.length} questions → ${data.questions.length} total`)
}

main().catch(e => { console.error(e); process.exit(1) })
