#!/usr/bin/env node
/**
 * Re-parse driver-license PDFs in _driver_license/ and fill in any items
 * with empty options in questions-driver-{car,moto}.json.
 *
 * Strategy: re-run parser only for items whose ID exists in current JSON.
 * Match by question.number, replace options if they're currently empty.
 */
const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')

const BACKEND = path.join(__dirname, '..')
const DIR = path.join(BACKEND, '_driver_license')

function cleanLine(s){ return s.replace(/\s+/g,' ').trim() }
function normalizeParens(s) {
  return s
    .replace(/[（(]\s*([１1])\s*[）)]/g, '(1)')
    .replace(/[（(]\s*([２2])\s*[）)]/g, '(2)')
    .replace(/[（(]\s*([３3])\s*[）)]/g, '(3)')
}

// Reuse simplified moto parser logic that captures question + options
async function parseMotoAll() {
  const buf = fs.readFileSync(path.join(DIR, 'moto_all_804.pdf'))
  const { text } = await pdfParse(buf)
  const lines = text.split('\n')
  const questions = []
  let nextNum = 1, state = 'EXPECT_NUM', cur = null

  function isHeader(line){
    return /機車駕照筆試題庫/.test(line)
      || /^—\s*\d+\s*—$/.test(line)
      || /^題號\s+答案\s+題目內容/.test(line)
      || /^【\s*題庫索引\s*】/.test(line)
      || /^━+$/.test(line)
  }
  function isSkip(line){ return /^分類\s*$/.test(line) || /^(正確觀念與態度|主動停讓文化|安全駕駛能力)\s*$/.test(line) }

  function appendToQ(q, line) {
    line = normalizeParens(line)
    if (/\([123]\)/.test(line)) {
      const idx1 = line.indexOf('(1)')
      if (idx1 > 0 && q.options.length === 0 && !q.questionText) {
        q.questionText = line.slice(0, idx1).trim()
        line = line.slice(idx1)
      }
      const parts = line.split(/(?=\([123]\))/)
      for (const p of parts) {
        const m = p.match(/^\(([123])\)\s*(.*)$/)
        if (m) {
          const existing = q.options.find(o => o.num === m[1])
          if (existing) existing.text += m[2]
          else q.options.push({ num: m[1], text: m[2] })
        } else if (q.options.length === 0 && p.trim()) {
          q.questionText += p.trim()
        } else if (q.options.length > 0 && p.trim()) {
          q.options[q.options.length - 1].text += p.trim()
        }
      }
      return
    }
    if (q.options.length > 0) q.options[q.options.length - 1].text += line
    else { if (q.questionText) q.questionText += line; else q.questionText = line }
  }
  function extractInline(q){
    q.questionText = normalizeParens(q.questionText)
    const text = q.questionText
    const firstOpt = text.indexOf('(1)')
    if (firstOpt > 0) {
      const qText = text.slice(0, firstOpt).trim()
      const optsPart = text.slice(firstOpt)
      q.questionText = qText
      const parts = optsPart.split(/(?=\([123]\))/)
      for (const p of parts) {
        const m = p.match(/^\(([123])\)\s*(.*)$/)
        if (m) q.options.push({ num: m[1], text: m[2].trim() })
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (isHeader(line)) continue
    if (nextNum <= 1 && isSkip(line)) continue

    if (state === 'EXPECT_NUM') {
      let m = line.match(/^(\d{1,3})\s+([123])\s+(.+)$/)
      if (m && parseInt(m[1]) === nextNum) {
        if (cur) questions.push(finalize(cur))
        cur = { number: nextNum, answer: m[2], questionText: m[3], options: [] }
        extractInline(cur); state = 'COLLECT'; nextNum++; continue
      }
      m = line.match(/^(\d{1,3})\s+([123])\s*$/)
      if (m && parseInt(m[1]) === nextNum) {
        if (cur) questions.push(finalize(cur))
        cur = { number: nextNum, answer: m[2], questionText: '', options: [] }
        state = 'COLLECT'; nextNum++; continue
      }
      m = line.match(/^(\d{1,3})\s*$/)
      if (m && parseInt(m[1]) === nextNum) {
        if (cur) questions.push(finalize(cur))
        cur = { number: nextNum, answer: null, questionText: '', options: [] }
        state = 'EXPECT_ANS'; nextNum++; continue
      }
      if (cur) appendToQ(cur, line)
      continue
    }
    if (state === 'EXPECT_ANS') {
      let m = line.match(/^([123])\s*$/)
      if (m) { cur.answer = m[1]; state = 'COLLECT'; continue }
      m = line.match(/^([123])\s+(.+)$/)
      if (m) { cur.answer = m[1]; cur.questionText = m[2]; extractInline(cur); state = 'COLLECT'; continue }
      cur.answer = null; state = 'COLLECT'; appendToQ(cur, line); continue
    }
    if (state === 'COLLECT') {
      let m = line.match(/^(\d{1,3})\s+([123])\s+(.+)$/)
      if (m && parseInt(m[1]) === nextNum) {
        questions.push(finalize(cur))
        cur = { number: nextNum, answer: m[2], questionText: m[3], options: [] }
        extractInline(cur); nextNum++; continue
      }
      m = line.match(/^(\d{1,3})\s+([123])\s*$/)
      if (m && parseInt(m[1]) === nextNum) {
        questions.push(finalize(cur))
        cur = { number: nextNum, answer: m[2], questionText: '', options: [] }
        nextNum++; continue
      }
      m = line.match(/^(\d{1,3})\s*$/)
      if (m && parseInt(m[1]) === nextNum) {
        questions.push(finalize(cur))
        cur = { number: nextNum, answer: null, questionText: '', options: [] }
        state = 'EXPECT_ANS'; nextNum++; continue
      }
      appendToQ(cur, line); continue
    }
  }
  if (cur) questions.push(finalize(cur))
  return questions
}

function finalize(q) {
  q.questionText = cleanLine(q.questionText)
  const opts = {}
  const ansMap = { '1':'A','2':'B','3':'C' }
  for (const o of q.options) {
    const k = ansMap[o.num] || o.num
    opts[k] = cleanLine(o.text).replace(/。$/,'').replace(/\.$/,'')
  }
  return { number: q.number, answer: ansMap[q.answer]||q.answer, question: q.questionText, options: opts }
}

async function parseCarChoice() {
  const buf = fs.readFileSync(path.join(DIR, 'car_rules_choice.pdf'))
  const { text } = await pdfParse(buf)
  const lines = text.split('\n')
  const questions = []
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (/^汽車法規選擇題/.test(line)) continue
    if (/^第\d+頁/.test(line)) continue
    if (/^題號\s+答案\s+題/.test(line)) continue
    if (/^分類編號欄位說明/.test(line)) continue
    if (/^分類編$/.test(line) || /^號\s*$/.test(line)) continue
    if (/^分類項目內容/.test(line)) continue
    if (/^\d{2}\s+[一-鿿]/.test(line) && line.length < 60 && !/[\(（]/.test(line)) continue
    if (/^分類$/.test(line) || /^編號\s*$/.test(line)) continue
    let m = line.match(/^(\d{3})\s+([123])\s+(.*)$/)
    if (m) {
      if (cur) questions.push(finalizeCar(cur))
      cur = { number: parseInt(m[1]), answer: m[2], textParts: [m[3]] }
      continue
    }
    m = line.match(/^(\d{3})\s+([123])\s*$/)
    if (m) {
      if (cur) questions.push(finalizeCar(cur))
      cur = { number: parseInt(m[1]), answer: m[2], textParts: [] }
      continue
    }
    if (/^\d{2}\s*$/.test(line) && parseInt(line) >= 1 && parseInt(line) <= 10) continue
    if (cur) cur.textParts.push(line)
  }
  if (cur) questions.push(finalizeCar(cur))
  return questions
}

function finalizeCar(q) {
  let fullText = normalizeParens(q.textParts.join(''))
  const firstOpt = fullText.indexOf('(1)')
  let qt, ot
  if (firstOpt >= 0) { qt = fullText.slice(0, firstOpt).trim(); ot = fullText.slice(firstOpt) }
  else { qt = fullText.trim(); ot = '' }
  const opts = {}; const ansMap = { '1':'A','2':'B','3':'C' }
  if (ot) {
    const parts = ot.split(/(?=\([123]\))/)
    for (const p of parts) {
      const m = p.match(/^\(([123])\)\s*(.*)$/)
      if (m) opts[ansMap[m[1]]] = cleanLine(m[2]).replace(/。\s*$/,'').replace(/\.\s*$/,'')
    }
  }
  return { number: q.number, answer: ansMap[q.answer], question: cleanLine(qt), options: opts }
}

// ─── Main: patch only items with empty options ─────────────────────────
async function main() {
  const fixed = []
  // Moto
  const motoQs = await parseMotoAll()
  const motoFp = path.join(BACKEND, 'questions-driver-moto.json')
  const motoArr = JSON.parse(fs.readFileSync(motoFp, 'utf8'))
  let motoFixed = 0
  for (const q of motoArr) {
    if (!q.options || !(q.options.A === '' || q.options.A == null)) continue
    if (q.options.A !== '') continue  // only fully empty
    const parsed = motoQs.find(p => p.number === q.number)
    if (!parsed || !parsed.options || Object.keys(parsed.options).length < 3) continue
    // sanity check: parsed question text should match (or fill blank)
    const oldText = (q.question || '').replace(/\s+/g,'')
    const newText = (parsed.question || '').replace(/\s+/g,'')
    // Accept if (a) original blank or (b) parsed contains original
    if (oldText && newText && !newText.startsWith(oldText.slice(0, Math.min(8, oldText.length)))) {
      // text mismatch: skip — can't trust
      continue
    }
    if (!q.question && parsed.question) q.question = parsed.question
    q.options.A = parsed.options.A || ''
    q.options.B = parsed.options.B || ''
    q.options.C = parsed.options.C || ''
    if (q.options.A && q.options.B && q.options.C) {
      motoFixed++
      fixed.push(`✓ driver-moto 第${q.number}題 — re-parsed from PDF`)
    }
  }
  if (motoFixed > 0) {
    fs.writeFileSync(motoFp, JSON.stringify(motoArr, null, 2))
    console.log(`driver-moto: ${motoFixed} fixed`)
  }
  // Car
  const carQs = await parseCarChoice()
  const carFp = path.join(BACKEND, 'questions-driver-car.json')
  const carArr = JSON.parse(fs.readFileSync(carFp, 'utf8'))
  let carFixed = 0
  for (const q of carArr) {
    if (!q.options) continue
    if (q.options.A !== '') continue
    if (q.id && !q.id.startsWith('car_choice_')) continue
    const parsed = carQs.find(p => p.number === q.number)
    if (!parsed || !parsed.options || Object.keys(parsed.options).length < 3) continue
    const oldText = (q.question || '').replace(/\s+/g,'')
    const newText = (parsed.question || '').replace(/\s+/g,'')
    if (oldText && newText && !newText.startsWith(oldText.slice(0, Math.min(8, oldText.length)))) continue
    if (!q.question && parsed.question) q.question = parsed.question
    q.options.A = parsed.options.A || ''
    q.options.B = parsed.options.B || ''
    q.options.C = parsed.options.C || ''
    if (q.options.A && q.options.B && q.options.C) {
      carFixed++
      fixed.push(`✓ driver-car 第${q.number}題 — re-parsed from PDF`)
    }
  }
  if (carFixed > 0) {
    fs.writeFileSync(carFp, JSON.stringify(carArr, null, 2))
    console.log(`driver-car: ${carFixed} fixed`)
  }

  console.log(`Total fixed: ${fixed.length}`)
  fixed.forEach(l => console.log(l))
  fs.writeFileSync(path.join(BACKEND, '_tmp', 'patrol-driver-log.json'),
    JSON.stringify({ moto_fixed: motoFixed, car_fixed: carFixed, log: fixed }, null, 2))
}

main().catch(e => { console.error(e); process.exit(1) })
