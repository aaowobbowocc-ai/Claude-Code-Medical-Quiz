#!/usr/bin/env node
/**
 * Recover discovered gaps:
 *   - doctor2 114-2 (code=114070, c=302, s=0101-0104)
 *   - nutrition 110-1 (code=110030, c=103, s=0201-0206)
 *   - nutrition 111-1 (code=111030, c=103, s=0201-0206)
 *
 * Usage:
 *   node scripts/recover-gaps.js --dry-run
 *   node scripts/recover-gaps.js
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'

// Config: recovery targets
// Note: s codes here are paired with subject names from the target file's existing schema
const TARGETS = [
  {
    examId: 'doctor2',
    file: 'questions-doctor2.json',
    year: '114', session: '第二次', code: '114070', classCode: '302',
    papers: [
      { s: '0101', subject: '醫學(三)', tag: 'internal_medicine', name: '醫學(三)' },
      { s: '0102', subject: '醫學(四)', tag: 'pediatrics',        name: '醫學(四)' },
      { s: '0103', subject: '醫學(五)', tag: 'surgery',           name: '醫學(五)' },
      { s: '0104', subject: '醫學(六)', tag: 'medical_law_ethics', name: '醫學(六)' },
    ],
  },
  {
    examId: 'nutrition',
    file: 'questions-nutrition.json',
    year: '110', session: '第一次', code: '110030', classCode: '103',
    papers: [
      { s: '0201', subject: '生理學與生物化學',   tag: 'physio_biochem',    name: '生理學與生物化學' },
      { s: '0202', subject: '營養學',             tag: 'nutrition_science', name: '營養學' },
      { s: '0203', subject: '膳食療養學',         tag: 'diet_therapy',      name: '膳食療養學' },
      { s: '0204', subject: '團體膳食設計與管理', tag: 'group_meal',        name: '團體膳食設計與管理' },
      { s: '0205', subject: '公共衛生營養學',     tag: 'public_nutrition',  name: '公共衛生營養學' },
      { s: '0206', subject: '食品衛生與安全',     tag: 'food_safety',       name: '食品衛生與安全' },
    ],
  },
  {
    examId: 'nutrition',
    file: 'questions-nutrition.json',
    year: '111', session: '第一次', code: '111030', classCode: '103',
    papers: [
      { s: '0201', subject: '生理學與生物化學',   tag: 'physio_biochem',    name: '生理學與生物化學' },
      { s: '0202', subject: '營養學',             tag: 'nutrition_science', name: '營養學' },
      { s: '0203', subject: '膳食療養學',         tag: 'diet_therapy',      name: '膳食療養學' },
      { s: '0204', subject: '團體膳食設計與管理', tag: 'group_meal',        name: '團體膳食設計與管理' },
      { s: '0205', subject: '公共衛生營養學',     tag: 'public_nutrition',  name: '公共衛生營養學' },
      { s: '0206', subject: '食品衛生與安全',     tag: 'food_safety',       name: '食品衛生與安全' },
    ],
  },
]

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 20000,
      headers: { 'User-Agent': UA, 'Accept': 'application/pdf,*/*', 'Referer': 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location
        if (!loc || !loc.startsWith('http')) { res.resume(); return reject(new Error('redirect')) }
        return fetchPdf(loc, retries).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800)
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      const ct = res.headers['content-type'] || ''
      if (!ct.includes('pdf') && !ct.includes('octet')) { res.resume(); return reject(new Error('not-pdf')) }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', (e) => {
      if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800)
      reject(e)
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function extract(buf) { return (await pdfParse(buf)).text }

function parseQuestions(text) {
  const questions = []
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  // Find where 選擇題 / 乙、 section starts (for old nutrition PDFs mixing 申論+選擇)
  // Skip past "乙、" or "測驗題部分" markers
  let startIdx = 0
  for (let i = 0; i < lines.length; i++) {
    if (/乙、測驗題部分|乙、測驗|測驗題部分|選擇題/.test(lines[i])) {
      startIdx = i + 1
      break
    }
  }
  const workLines = startIdx > 0 ? lines.slice(startIdx) : lines

  let currentQ = null
  let currentOpt = null
  let buffer = ''

  const flushOpt = () => {
    if (currentQ && currentOpt) currentQ.options[currentOpt] = buffer.trim()
    buffer = ''; currentOpt = null
  }
  const flushQ = () => {
    flushOpt()
    if (currentQ && currentQ.question && Object.keys(currentQ.options).length >= 2) {
      questions.push(currentQ)
    }
    currentQ = null
  }

  for (const rawLine of workLines) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^(代\s*號|類\s*科|科\s*目|考試|頁次|等\s*別|全.*題|本試題|座號|※|【|】|甲、|乙、)/.test(line)) continue
    if (/^第?\s*\d+\s*頁/.test(line)) continue

    const qMatch = line.match(/^(\d{1,3})[.、．]\s*(.*)$/)
    if (qMatch) {
      const num = parseInt(qMatch[1])
      const rest = (qMatch[2] || '').trim()
      const looksLikeQ = rest === '' || /[\u4e00-\u9fff a-zA-Z（(]/.test(rest)
      const isFirst = !currentQ && questions.length === 0
      const isNext = currentQ && num === currentQ.number + 1
      if (looksLikeQ && num >= 1 && num <= 99 && (isFirst || isNext)) {
        flushQ()
        currentQ = { number: num, question: rest, options: {} }
        continue
      }
    }

    const optMatch = line.match(/^[（(]?\s*([A-Da-dＡＢＣＤ])\s*[)）]?\s*[.\s]?\s*(.*)$/)
    if (optMatch && currentQ) {
      const letter = optMatch[1].toUpperCase()
        .replace('Ａ','A').replace('Ｂ','B').replace('Ｃ','C').replace('Ｄ','D')
      flushOpt()
      currentOpt = letter
      buffer = optMatch[2] || ''
      continue
    }

    if (currentOpt) buffer += ' ' + line
    else if (currentQ) currentQ.question += ' ' + line
  }
  flushQ()
  return questions
}

function parseAnswers(text) {
  const answers = {}
  const fw = /答案\s*([ＡＢＣＤ#＃]+)/g
  let m, n = 1
  while ((m = fw.exec(text)) !== null) {
    for (const ch of m[1]) {
      const map = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (map) answers[n++] = map
    }
  }
  if (Object.keys(answers).length >= 20) return answers
  const hw = /(\d{1,3})\s*[.、．:：]\s*([A-Da-d])/g
  while ((m = hw.exec(text)) !== null) {
    const num = parseInt(m[1])
    if (num >= 1 && num <= 120) answers[num] = m[2].toUpperCase()
  }
  return answers
}

function parseCorrections(text) {
  const corrections = {}
  const norm = text.replace(/Ａ/g, 'A').replace(/Ｂ/g, 'B').replace(/Ｃ/g, 'C').replace(/Ｄ/g, 'D')
  const voidRe = /第\s*(\d{1,3})\s*題[^，。\n第]*?一律給分/g
  let m
  while ((m = voidRe.exec(norm)) !== null) {
    corrections[parseInt(m[1])] = { kind: 'void' }
  }
  const multiRe = /第\s*(\d{1,3})\s*題[^第]*?答([^給第]*?)給分/g
  while ((m = multiRe.exec(norm)) !== null) {
    const num = parseInt(m[1])
    if (corrections[num]) continue
    const letters = [...new Set((m[2].match(/[ABCD]/g) || []))].sort()
    if (letters.length >= 1) {
      corrections[num] = { kind: 'multi', answers: letters.join(',') }
    }
  }
  return corrections
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function scrapeTarget(target, dryRun) {
  console.log(`\n--- ${target.examId} ${target.year}${target.session} (code=${target.code} c=${target.classCode}) ---`)
  const results = []
  for (const p of target.papers) {
    const qUrl = `${BASE}?t=Q&code=${target.code}&c=${target.classCode}&s=${p.s}&q=1`
    const aUrl = `${BASE}?t=S&code=${target.code}&c=${target.classCode}&s=${p.s}&q=1`
    const mUrl = `${BASE}?t=M&code=${target.code}&c=${target.classCode}&s=${p.s}&q=1`

    if (dryRun) { console.log(`  ${p.subject}: ${qUrl}`); continue }

    let qText
    try { qText = await extract(await fetchPdf(qUrl)) }
    catch (e) { console.log(`  ✗ ${p.subject}: Q fetch failed (${e.message})`); continue }

    let answers = {}
    try { answers = parseAnswers(await extract(await fetchPdf(aUrl))) }
    catch (e) { console.log(`  ⚠ ${p.subject}: no answer PDF`) }

    let corrections = {}
    try { corrections = parseCorrections(await extract(await fetchPdf(mUrl))) } catch {}

    const parsed = parseQuestions(qText)
    console.log(`  ✓ ${p.subject} (s=${p.s}): ${parsed.length} Q, ${Object.keys(answers).length} A, ${Object.keys(corrections).length} corr`)

    for (const q of parsed) {
      const ans = answers[q.number]
      if (!ans) continue
      const corr = corrections[q.number]
      let finalAns = ans
      let disputed = undefined, correctionNote = undefined, originalAnswer = undefined
      if (corr) {
        if (corr.kind === 'void') {
          finalAns = '送分'
          disputed = true
          originalAnswer = ans
          correctionNote = `第${q.number}題一律給分（原答案 ${ans}）`
        } else {
          finalAns = corr.answers
          disputed = true
          originalAnswer = ans
          correctionNote = `第${q.number}題更正為 ${corr.answers}（原答案 ${ans}）`
        }
      }
      results.push({
        roc_year: target.year,
        session: target.session,
        exam_code: target.code,
        subject: p.subject,
        subject_tag: p.tag,
        subject_name: p.name,
        stage_id: 0,
        number: q.number,
        question: q.question.trim(),
        options: q.options,
        answer: finalAns,
        explanation: '',
        ...(disputed ? { disputed, original_answer: originalAnswer, correction_note: correctionNote } : {}),
      })
    }
    await sleep(300)
  }
  return results
}

function mergeIntoFile(file, newQs) {
  const filePath = path.join(__dirname, '..', file)
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  const existing = data.questions || data
  const isWrapped = !!data.questions

  let maxId = 0
  for (const q of existing) {
    const numId = typeof q.id === 'number' ? q.id : parseInt(String(q.id).replace(/[^\d]/g, '')) || 0
    if (numId > maxId) maxId = numId
  }

  const existingKeys = new Set()
  for (const q of existing) existingKeys.add(`${q.exam_code}|${q.subject}|${q.number}`)

  let added = 0
  for (const q of newQs) {
    const key = `${q.exam_code}|${q.subject}|${q.number}`
    if (existingKeys.has(key)) continue
    existing.push({ id: ++maxId, ...q })
    added++
  }

  const output = isWrapped ? { ...data, total: existing.length, questions: existing } : existing
  fs.writeFileSync(filePath, JSON.stringify(output, null, 2) + '\n', 'utf-8')
  console.log(`\n✅ ${file}: +${added} new (total ${existing.length})`)
  return added
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')

  // Group by file for batching merges
  const resultsByFile = {}
  for (const target of TARGETS) {
    const qs = await scrapeTarget(target, dryRun)
    if (!resultsByFile[target.file]) resultsByFile[target.file] = []
    resultsByFile[target.file].push(...qs)
  }

  if (dryRun) return

  let grandTotal = 0
  for (const [file, qs] of Object.entries(resultsByFile)) {
    grandTotal += mergeIntoFile(file, qs) || 0
  }
  console.log(`\n${'='.repeat(60)}\nGrand total added: ${grandTotal}\n${'='.repeat(60)}`)
}

main().catch(e => { console.error(e); process.exit(1) })
