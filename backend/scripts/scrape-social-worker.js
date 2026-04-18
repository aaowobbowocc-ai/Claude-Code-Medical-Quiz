#!/usr/bin/env node
// Scrape 社會工作師 MCQ subjects using pdfjs-dist position data
// Subjects: 社會工作 (40Q) + 社會工作直接服務 (40Q) + 社會工作管理 (40Q)
// All are mixed essay+MCQ format (50% essay, 50% MCQ)
// Available: 112-115 (第一次), c=103

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfjsLib = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')
const pdfParse = require('pdf-parse')

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
      // Skip if rest starts with a digit AND the full leading number != expectNext
      // e.g. "889歲" when expecting 8: full leading = 889 ≠ 8, so this IS Q8 (8 + "89歲")
      // e.g. "10社會" when expecting 10: full leading = 10 = 10, so this IS Q10
      // e.g. "114年" when expecting 1: full leading = 114 ≠ 1, skip (year in header)
      const fullLeading = line.text.match(/^(\d+)/)[1]
      const fullNum = parseInt(fullLeading)
      if (fullNum !== expectNext) {
        // The full leading number doesn't match — could be our number + digit content
        // Accept if our expected number is a prefix AND rest doesn't look like a year/header
        if (/^年\s*(第|公務|專門|國家|特種)/.test(rest)) continue
        // Accept: "889歲" = Q8 + "89歲"
      } else {
        // Full leading number matches exactly (e.g. "10社會" = Q10)
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
  const { text } = await pdfParse(buf)
  const answers = {}
  const fw = /答案\s*([ＡＢＣＤ]+)/g
  let m, n = 1
  while ((m = fw.exec(text)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) answers[n++] = k
    }
  }
  if (Object.keys(answers).length >= 5) return answers
  let cleaned = text.replace(/第\d{1,3}題/g, '').replace(/題號/g, '').replace(/答案/g, '')
    .replace(/標準/g, '').replace(/[\s\n\r]+/g, '')
  let idx = 1
  for (const ch of cleaned) {
    if (ch === 'A' || ch === 'B' || ch === 'C' || ch === 'D') answers[idx++] = ch
  }
  return answers
}

async function parseCorrections(buf) {
  const { text } = await pdfParse(buf)
  const corrections = { disputed: [], changed: [] }
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  for (const line of lines) {
    const giveMatch = line.match(/第\s*(\d+)\s*題.*一律給分/i) || line.match(/(\d+)\s*.*送分/)
    if (giveMatch) {
      corrections.disputed.push(parseInt(giveMatch[1]))
      continue
    }
    const changeMatch = line.match(/第\s*(\d+)\s*題.*答案[更修]正.*?([ABCD])/i) ||
                         line.match(/(\d+)\s*.*更正.*?([ABCD])/)
    if (changeMatch) {
      corrections.changed.push({ num: parseInt(changeMatch[1]), answer: changeMatch[2] })
    }
  }
  return corrections
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
    { year: '112', code: '112030', session: '第一次' },
    { year: '112', code: '112110', session: '第二次' },
    { year: '113', code: '113030', session: '第一次' },
    { year: '113', code: '113100', session: '第二次' },
    { year: '114', code: '114030', session: '第一次' },
    { year: '114', code: '114100', session: '第二次' },
    { year: '115', code: '115030', session: '第一次' },
  ]
  const SUBJECTS = [
    { c: '103', s: '0301', name: '社會工作', tag: 'social_work', expectedQ: 40, mixedEssay: true },
    { c: '103', s: '0302', name: '社會工作直接服務', tag: 'social_work_direct', expectedQ: 40, mixedEssay: true },
    { c: '103', s: '0303', name: '社會工作管理', tag: 'social_work_mgmt', expectedQ: 40, mixedEssay: true },
  ]
  const file = path.join(__dirname, '..', 'questions-social-worker.json')

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
      const mUrl = `${BASE}?t=M&code=${sess.code}&c=${sub.c}&s=${sub.s}&q=1`
      let qBuf, aBuf, mBuf

      try { qBuf = await fetchPdf(qUrl) } catch (e) {
        console.log(`  ✗ ${sub.name}: ${e.message}`); continue
      }
      try { aBuf = await fetchPdf(aUrl) } catch (e) {
        console.log(`  ⚠ ${sub.name} no answers: ${e.message}`); aBuf = null
      }
      try { mBuf = await fetchPdf(mUrl) } catch (e) { mBuf = null }

      let posItems = await extractPositionedText(qBuf)
      // Skip to 選擇題 section
      const mcqIdx = posItems.findIndex(it => it.str.includes('選擇題'))
      if (mcqIdx >= 0) {
        posItems = posItems.slice(mcqIdx)
      } else {
        console.log(`  ⚠ ${sub.name}: no 選擇題 section found`); continue
      }

      const logLines = buildLogicalLines(posItems)
      const parsed = parseQuestions(logLines)
      const answers = aBuf ? await parseAnswers(aBuf) : {}

      // Apply corrections
      let corrections = { disputed: [], changed: [] }
      if (mBuf) {
        corrections = await parseCorrections(mBuf)
        if (corrections.disputed.length || corrections.changed.length)
          console.log(`  📋 corrections: ${corrections.disputed.length} disputed, ${corrections.changed.length} changed`)
        for (const c of corrections.changed) answers[c.num] = c.answer
      }

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
        if (corrections.disputed.includes(q.number)) entry.disputed = true
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
