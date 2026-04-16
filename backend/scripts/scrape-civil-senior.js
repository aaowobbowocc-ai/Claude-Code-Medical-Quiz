#!/usr/bin/env node
// Scrape 高考三等 MCQ subjects using pdfjs-dist position data
// for proper 2-column option layout parsing.
// Currently: 114年 法學知識與英文 (50Q) + 國文測驗 (10Q)

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfjsLib = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 25000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*',
                 Referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
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
      const ct = res.headers['content-type'] || ''
      if (!ct.includes('pdf') && !ct.includes('octet')) { res.resume(); return reject(new Error('not PDF')) }
      const cs = []
      res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    })
    req.on('error', e => retries > 0 ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800) : reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

// Extract structured text with x,y positions from all pages
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
  // Sort by page, then y descending (top to bottom), then x ascending
  allItems.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)
  return allItems
}

// Build logical lines from positioned items.
// Items on the same y (±3px) are on the same visual row.
// Items at x < 200 are column 1, items at x > 200 are column 2.
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

  // For each row, detect column boundaries by finding x-gaps between items.
  // MoEX exam PDFs use 2-column (x≈69, x≈308) or 4-column (x≈69, 187, 308, 427) layouts.
  const lines = []
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x)

    // Find all significant x-gaps (>60px between items)
    const gapIdxs = []
    for (let i = 1; i < row.length; i++) {
      const prevEnd = row[i - 1].x + row[i - 1].str.length * 11 // rough char width
      if (row[i].x - prevEnd > 30 || row[i].x - row[i - 1].x > 80) {
        gapIdxs.push(i)
      }
    }

    if (gapIdxs.length >= 3) {
      // 4 columns (for very short options like Q7, Q17)
      const breaks = [0, ...gapIdxs, row.length]
      for (let b = 0; b < breaks.length - 1; b++) {
        const chunk = row.slice(breaks[b], breaks[b + 1])
        const text = chunk.map(r => r.str).join('').trim()
        if (text) lines.push({ text, x: chunk[0].x, y: row[0].y, col: 'C' + b })
      }
    } else if (gapIdxs.length >= 1) {
      // 2 columns
      const left = row.slice(0, gapIdxs[0]).map(r => r.str).join('').trim()
      const right = row.slice(gapIdxs[0]).map(r => r.str).join('').trim()
      if (left) lines.push({ text: left, x: row[0].x, y: row[0].y, col: 'L' })
      if (right) lines.push({ text: right, x: row[gapIdxs[0]].x, y: row[0].y, col: 'R' })
    } else {
      // Single column
      const text = row.map(r => r.str).join('').trim()
      if (text) lines.push({ text, x: row[0].x, y: row[0].y, col: 'F' })
    }
  }
  return lines
}

// Parse questions from logical lines
function parseQuestions(lines) {
  // Filter header lines
  const filtered = lines.filter(l => {
    const t = l.text
    if (/^(代號|類\s*科|科\s*目|考試|頁次|等\s*別|本試題|座號|※|禁止|本科目|須用|共\d+題)/.test(t)) return false
    if (/^\d+－\d+$/.test(t)) return false
    if (/^頁次/.test(t)) return false
    return true
  })

  // Find question starts
  const qStarts = []
  let expectNext = 1
  for (let i = 0; i < filtered.length; i++) {
    const line = filtered[i]
    // Question numbers start at x ≈ 41 (left margin, smaller than option indent of 69+)
    if (line.x > 60) continue // Skip option-indent lines for number detection
    const es = String(expectNext)
    if (line.text.startsWith(es)) {
      const rest = line.text.slice(es.length)
      if (rest.length > 0 && !/^\d/.test(rest[0]) && !/^年\s*(第|公務|專門|國家|特種)/.test(rest)) {
        qStarts.push({ idx: i, number: expectNext })
        expectNext++
      }
    }
  }

  // Extract questions
  const questions = []
  for (let qi = 0; qi < qStarts.length; qi++) {
    const start = qStarts[qi].idx
    const end = qi + 1 < qStarts.length ? qStarts[qi + 1].idx : filtered.length
    const num = qStarts[qi].number
    const block = filtered.slice(start, end)

    // First item: "Nquestion text"
    const stemText = block[0].text.slice(String(num).length).trim()
    const restItems = block.slice(1)

    // Separate stem from options.
    // Stem lines are at x ≈ 58 (question indent). Options at x ≈ 69+ or column items.
    // Stem usually ends with ？ or ：
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

    // Group option items into A/B/C/D.
    // Options come in pairs on the same y-row (col L=odd option, col R=even option)
    // Or as full-width lines (one option per line).
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

  // Group items by approximate y value (options on same row share y)
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

  // Each yGroup may have 1, 2, or 4 options (based on column split).
  // Build option list in reading order.
  const opts = []
  for (const group of yGroups) {
    // Sort by x for correct reading order
    group.sort((a, b) => a.x - b.x)

    // Check if this is a multi-column row (has C0/C1/C2/C3 or L/R columns)
    const colTypes = new Set(group.map(it => it.col))

    if (colTypes.has('C0') || colTypes.has('C1') || colTypes.has('C2') || colTypes.has('C3')) {
      // 4-column: each item is a separate option
      for (const item of group) {
        opts.push(item.text)
      }
    } else if (colTypes.has('L') && colTypes.has('R')) {
      // 2-column: left + right
      const left = group.filter(it => it.col === 'L').map(it => it.text).join('')
      const right = group.filter(it => it.col === 'R').map(it => it.text).join('')
      opts.push(left)
      opts.push(right)
    } else {
      // Single column: one option or continuation
      const fullText = group.map(it => it.text).join('')
      if (opts.length > 0 && group[0].x > 65 && group[0].col === 'F' && fullText.length < 25) {
        // Continuation of previous option
        opts[opts.length - 1] += fullText
      } else {
        opts.push(fullText)
      }
    }
  }
  return opts
}

// Parse answers from answer PDF (using pdf-parse for simplicity)
const pdfParse = require('pdf-parse')

async function parseAnswers(buf) {
  const { text } = await pdfParse(buf)
  const answers = {}
  // Fullwidth format
  const fw = /答案\s*([ＡＢＣＤ]+)/g
  let m, n = 1
  while ((m = fw.exec(text)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) answers[n++] = k
    }
  }
  if (Object.keys(answers).length >= 5) return answers
  // Tabular format
  let cleaned = text.replace(/第\d{1,3}題/g, '').replace(/題號/g, '').replace(/答案/g, '')
    .replace(/標準/g, '').replace(/[\s\n\r]+/g, '')
  let idx = 1
  for (const ch of cleaned) {
    if (ch === 'A' || ch === 'B' || ch === 'C' || ch === 'D') answers[idx++] = ch
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
    { year: '114', code: '114080', session: '第一次' },
  ]
  const SUBJECTS = [
    { c: '201', s: '0401', name: '法學知識與英文', tag: 'law_knowledge_english', expectedQ: 50 },
  ]
  const file = path.join(__dirname, '..', 'questions-civil-senior.json')

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
      const posItems = await extractPositionedText(qBuf)
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
        added.push({
          id: nextId++, roc_year: sess.year, session: sess.session, exam_code: sess.code,
          subject: sub.name, subject_tag: sub.tag, subject_name: sub.name,
          stage_id: 0, number: q.number,
          question: stripPUA(q.question), options: cleanOpts,
          answer: ans, explanation: '',
        })
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
