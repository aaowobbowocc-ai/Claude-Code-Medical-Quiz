#!/usr/bin/env node
/**
 * Recover nursing gaps via layout-aware PUA parser.
 *
 * Discovered codes (verified 2026-04):
 *   110 第一次: 110030 c=104 s=0301-0305 (80Q each, PUA format)
 *   111 第一次: 111030 c=104 s=0301-0305 (80Q each, PUA format)
 *   112 第一次: 112030 c=102 s=0201 (50Q) + s=0202-0205 (80Q each, PUA format) — re-scrape to fix parser drops
 *   113 第一次: 113030 c=101 s=11,22,33,44,55 (OLD text format with "1." delimiters)
 *   113 第二次: 113100 c=102 s=0201-0205 (50Q each, PUA format) — re-scrape to fix drops
 *   112 第三次: 112180 c=101 s=0101,0102,0103,0201,0202 (50Q each, PUA format)
 *   113 第三次: 113180 c=101 s=0101,0102,0103,0201,0202 (50Q each, PUA format)
 *   114 第一次: re-scrape text format to fix drops (#36 基礎, #11 基本護理)
 *
 * Usage:
 *   node scripts/recover-nursing.js --dry-run
 *   node scripts/recover-nursing.js
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'

const SUBJECTS = [
  { name: '基礎醫學', tag: 'basic_medicine' },
  { name: '基本護理學與護理行政', tag: 'basic_nursing' },
  { name: '內外科護理學', tag: 'med_surg' },
  { name: '產兒科護理學', tag: 'obs_ped' },
  { name: '精神科與社區衛生護理學', tag: 'psych_community' },
]

const TARGETS = [
  {
    year: '110', session: '第一次', code: '110030', classCode: '104', format: 'pua',
    papers: [
      { sub: SUBJECTS[0], s: '0301' },
      { sub: SUBJECTS[1], s: '0302' },
      { sub: SUBJECTS[2], s: '0303' },
      { sub: SUBJECTS[3], s: '0304' },
      { sub: SUBJECTS[4], s: '0305' },
    ],
  },
  {
    year: '111', session: '第一次', code: '111030', classCode: '104', format: 'pua',
    papers: [
      { sub: SUBJECTS[0], s: '0301' },
      { sub: SUBJECTS[1], s: '0302' },
      { sub: SUBJECTS[2], s: '0303' },
      { sub: SUBJECTS[3], s: '0304' },
      { sub: SUBJECTS[4], s: '0305' },
    ],
  },
  {
    year: '112', session: '第一次', code: '112030', classCode: '102', format: 'pua',
    papers: [
      { sub: SUBJECTS[0], s: '0201' },
      { sub: SUBJECTS[1], s: '0202' },
      { sub: SUBJECTS[2], s: '0203' },
      { sub: SUBJECTS[3], s: '0204' },
      { sub: SUBJECTS[4], s: '0205' },
    ],
  },
  {
    year: '113', session: '第一次', code: '113030', classCode: '101', format: 'text-old',
    papers: [
      { sub: SUBJECTS[0], s: '11' },
      { sub: SUBJECTS[1], s: '22' },
      { sub: SUBJECTS[2], s: '33' },
      { sub: SUBJECTS[3], s: '44' },
      { sub: SUBJECTS[4], s: '55' },
    ],
  },
  {
    year: '113', session: '第二次', code: '113100', classCode: '102', format: 'pua',
    papers: [
      { sub: SUBJECTS[0], s: '0201' },
      { sub: SUBJECTS[1], s: '0202' },
      { sub: SUBJECTS[2], s: '0203' },
      { sub: SUBJECTS[3], s: '0204' },
      { sub: SUBJECTS[4], s: '0205' },
    ],
  },
  {
    year: '112', session: '第三次', code: '112180', classCode: '101', format: 'pua',
    papers: [
      { sub: SUBJECTS[0], s: '0101' },
      { sub: SUBJECTS[1], s: '0102' },
      { sub: SUBJECTS[2], s: '0103' },
      { sub: SUBJECTS[3], s: '0201' },
      { sub: SUBJECTS[4], s: '0202' },
    ],
  },
  {
    year: '113', session: '第三次', code: '113180', classCode: '101', format: 'pua',
    papers: [
      { sub: SUBJECTS[0], s: '0101' },
      { sub: SUBJECTS[1], s: '0102' },
      { sub: SUBJECTS[2], s: '0103' },
      { sub: SUBJECTS[3], s: '0201' },
      { sub: SUBJECTS[4], s: '0202' },
    ],
  },
  {
    year: '114', session: '第一次', code: '114030', classCode: '101', format: 'text-new',
    papers: [
      { sub: SUBJECTS[0], s: '0101' },
      { sub: SUBJECTS[1], s: '0102' },
      { sub: SUBJECTS[2], s: '0103' },
      { sub: SUBJECTS[3], s: '0104' },
      { sub: SUBJECTS[4], s: '0105' },
    ],
  },
]

// ─── HTTP ───────────────────────────────────────────────────────────
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

// ─── PUA layout-aware parser ───────────────────────────────────────
// 考選部 新格式 PDF 中選項以私有區字元 U+E18C/E18D/E18E/E18F 分隔（對應 A/B/C/D）
function parsePua(text) {
  if (!text.includes('\uE18C')) return null

  let headerEnd = 0
  const headerMarkers = [/頁次[：:]\s*\d+[－\-]\d+/, /本試題禁止使用電子計算器/, /代號[：:]\s*\d+/]
  for (const re of headerMarkers) {
    const m = text.match(re)
    if (m && m.index + m[0].length > headerEnd) headerEnd = m.index + m[0].length
  }

  const posA = []
  for (let i = headerEnd; i < text.length; i++) {
    if (text.charCodeAt(i) === 0xE18C) posA.push(i)
  }
  if (posA.length === 0) return []

  const questions = []
  let prevQEnd = headerEnd

  for (let i = 0; i < posA.length; i++) {
    const optA_start = posA[i]
    let posD = -1, posE = -1, posF = -1
    for (let j = optA_start + 1; j < text.length; j++) {
      const c = text.charCodeAt(j)
      if (c === 0xE18D && posD < 0) posD = j
      else if (c === 0xE18E && posE < 0) posE = j
      else if (c === 0xE18F && posF < 0) { posF = j; break }
    }
    if (posD < 0 || posE < 0 || posF < 0) continue

    const optA = text.slice(optA_start + 1, posD).replace(/\s+/g, '').trim()
    const optB = text.slice(posD + 1, posE).replace(/\s+/g, '').trim()
    const optC = text.slice(posE + 1, posF).replace(/\s+/g, '').trim()

    const nextA = i + 1 < posA.length ? posA[i + 1] : text.length
    const afterD = text.slice(posF + 1, nextA)

    const currentNum = i + 1
    const nextNum = i + 2
    let optD, nextQStart
    const nextRe = new RegExp('^([\\s\\S]*?)(?:^|[^0-9])(' + nextNum + ')([\\u4e00-\\u9fff])', 'm')
    const m = afterD.match(nextRe)
    if (m) {
      optD = afterD.slice(0, m.index + m[1].length).replace(/\s+/g, '').trim()
      nextQStart = posF + 1 + afterD.indexOf(m[2] + m[3])
    } else {
      optD = afterD.replace(/\s+/g, '').trim()
      nextQStart = null
    }

    let questionChunk = text.slice(prevQEnd, optA_start).replace(/\s+/g, '').trim()
    const qnMatch = questionChunk.match(/^(\d{1,3})([\u4e00-\u9fff][\s\S]*)$/)
    const qNum = qnMatch ? parseInt(qnMatch[1]) : currentNum
    const qText = qnMatch ? qnMatch[2] : questionChunk

    questions.push({
      number: qNum,
      question: qText,
      options: { A: optA, B: optB, C: optC, D: optD },
    })

    prevQEnd = nextQStart || (posF + 1 + afterD.length)
  }
  return questions
}

// ─── Text-format parser (舊 2-code + 114+ "1. A. B." style) ────────
function parseTextFormat(text) {
  const questions = []
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

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

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^(代\s*號|類\s*科|科\s*目|考試|頁次|等\s*別|全.*題|本試題|本科目|座號|※|甲、|乙、)/.test(line)) continue
    if (/^第?\s*\d+\s*頁/.test(line)) continue

    const qMatch = line.match(/^(\d{1,3})[.、．]\s*(.*)$/)
    if (qMatch) {
      const num = parseInt(qMatch[1])
      const rest = (qMatch[2] || '').trim()
      const looksLikeQ = rest === '' || /[\u4e00-\u9fff a-zA-Z（(]/.test(rest[0] || '')
      const isFirst = !currentQ && questions.length === 0
      const isNext = currentQ && num === currentQ.number + 1
      if (looksLikeQ && num >= 1 && num <= 120 && (isFirst || isNext)) {
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

// ─── Answer & correction parsers ───────────────────────────────────
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

// ─── Scrape single target ─────────────────────────────────────────
async function scrapeTarget(target, dryRun) {
  console.log(`\n--- ${target.year} ${target.session} (code=${target.code} c=${target.classCode} ${target.format}) ---`)
  const results = []
  for (const p of target.papers) {
    const qUrl = `${BASE}?t=Q&code=${target.code}&c=${target.classCode}&s=${p.s}&q=1`
    const aUrl = `${BASE}?t=S&code=${target.code}&c=${target.classCode}&s=${p.s}&q=1`
    const mUrl = `${BASE}?t=M&code=${target.code}&c=${target.classCode}&s=${p.s}&q=1`

    if (dryRun) { console.log(`  ${p.sub.name}: ${qUrl}`); continue }

    let qText
    try { qText = await extract(await fetchPdf(qUrl)) }
    catch (e) { console.log(`  ✗ ${p.sub.name}: Q fetch failed (${e.message})`); continue }

    let parsed
    if (target.format === 'pua') {
      parsed = parsePua(qText) || parseTextFormat(qText)
    } else {
      parsed = parseTextFormat(qText)
    }

    let answers = {}
    try { answers = parseAnswers(await extract(await fetchPdf(aUrl))) }
    catch { console.log(`  ⚠ ${p.sub.name}: no answer PDF`) }

    let corrections = {}
    try { corrections = parseCorrections(await extract(await fetchPdf(mUrl))) } catch {}

    const withAns = parsed.filter(q => answers[q.number])
    console.log(`  ✓ ${p.sub.name} (s=${p.s}): ${parsed.length} Q, ${Object.keys(answers).length} A, ${withAns.length} paired, ${Object.keys(corrections).length} corr`)

    for (const q of parsed) {
      const ans = answers[q.number]
      if (!ans) continue
      const corr = corrections[q.number]
      let finalAns = ans
      let disputed, correctionNote, originalAnswer
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
        subject: p.sub.name,
        subject_tag: p.sub.tag,
        subject_name: p.sub.name,
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

// ─── Merge into file ──────────────────────────────────────────────
function mergeIntoFile(filePath, newQs) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  const existing = data.questions || data
  const isWrapped = !!data.questions

  const existingKeys = new Set()
  for (const q of existing) existingKeys.add(`${q.exam_code}|${q.subject}|${q.number}`)

  let added = 0
  for (const q of newQs) {
    const key = `${q.exam_code}|${q.subject}|${q.number}`
    if (existingKeys.has(key)) continue
    const id = `${q.exam_code}_${q.subject_tag}_${q.number}`
    existing.push({ id, ...q })
    existingKeys.add(key)
    added++
  }

  const output = isWrapped ? { ...data, total: existing.length, questions: existing } : existing
  fs.writeFileSync(filePath, JSON.stringify(output, null, 2) + '\n', 'utf-8')
  console.log(`\n✅ ${path.basename(filePath)}: +${added} new (total ${existing.length})`)
  return added
}

// ─── Main ──────────────────────────────────────────────────────────
async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const all = []
  for (const target of TARGETS) {
    const qs = await scrapeTarget(target, dryRun)
    all.push(...qs)
  }
  if (dryRun) return
  const filePath = path.join(__dirname, '..', 'questions-nursing.json')
  mergeIntoFile(filePath, all)
  console.log(`\n${'='.repeat(60)}\nScraped: ${all.length} total, merged with dedup\n${'='.repeat(60)}`)
}

main().catch(e => { console.error(e); process.exit(1) })
