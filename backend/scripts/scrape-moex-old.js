#!/usr/bin/env node
/**
 * 考選部國考題庫爬蟲 — 舊系統格式 (OLD system, pre-114)
 * URL pattern: c=3XX (3-digit), s=XY (2-digit, X=paper number, Y=variant)
 * Used to backfill 110-113 年題目
 *
 * Usage:
 *   node scripts/scrape-moex-old.js --exam all
 *   node scripts/scrape-moex-old.js --exam doctor1 --year 110
 *   node scripts/scrape-moex-old.js --exam medlab --dry-run
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

// ─── 考試定義（舊系統格式）───
// classCode: 300 系列 (3-digit)
// papers: {s (2-digit), subject (必須對應 existing JSON subject field), defaultTag}
const OLD_EXAM_DEFS = {
  doctor1: {
    label: '醫師(一)',
    file: 'questions.json',
    classCode: '301',
    papers: [
      { s: '11', subject: '醫學(一)', tag: 'anatomy', name: '醫學(一)' },
      { s: '22', subject: '醫學(二)', tag: 'pathology', name: '醫學(二)' },
    ],
  },
  doctor2: {
    label: '醫師(二)',
    file: 'questions-doctor2.json',
    classCode: '302',
    papers: [
      { s: '11', subject: '醫學(三)', tag: 'internal_medicine', name: '醫學(三)' },
      { s: '22', subject: '醫學(四)', tag: 'pediatrics',       name: '醫學(四)' },
      { s: '33', subject: '醫學(五)', tag: 'surgery',          name: '醫學(五)' },
      { s: '44', subject: '醫學(六)', tag: 'medical_law_ethics', name: '醫學(六)' },
    ],
  },
  dental1: {
    label: '牙醫師(一)',
    file: 'questions-dental1.json',
    classCode: '303',
    papers: [
      { s: '11', subject: '卷一', tag: 'dental_anatomy',   name: '牙醫學(一)' },
      { s: '22', subject: '卷二', tag: 'oral_pathology',   name: '牙醫學(二)' },
    ],
  },
  dental2: {
    label: '牙醫師(二)',
    file: 'questions-dental2.json',
    classCode: '304',
    papers: [
      { s: '33', subject: '卷一', tag: 'periodontics',            name: '牙醫學(三)' },
      { s: '44', subject: '卷二', tag: 'oral_surgery',            name: '牙醫學(四)' },
      { s: '55', subject: '卷三', tag: 'fixed_prosthodontics',    name: '牙醫學(五)' },
      { s: '66', subject: '卷四', tag: 'dental_public_health',    name: '牙醫學(六)' },
    ],
  },
  pharma1: {
    label: '藥師(一)',
    file: 'questions-pharma1.json',
    classCode: '305',
    papers: [
      { s: '33', subject: '卷一', tag: 'pharmacology',            name: '藥理學與藥物化學' },
      { s: '44', subject: '卷二', tag: 'pharmaceutical_analysis', name: '藥物分析與生藥學' },
      { s: '55', subject: '卷三', tag: 'pharmaceutics',           name: '藥劑學與生物藥劑學' },
    ],
  },
  pharma2: {
    label: '藥師(二)',
    file: 'questions-pharma2.json',
    classCode: '306',
    papers: [
      { s: '44', subject: '調劑與臨床', tag: 'dispensing',        name: '調劑學與臨床藥學' },
      { s: '55', subject: '藥物治療',   tag: 'pharmacotherapy',   name: '藥物治療學' },
      { s: '66', subject: '法規',       tag: 'pharmacy_law',      name: '藥事行政與法規' },
    ],
  },
  medlab: {
    label: '醫事檢驗師',
    file: 'questions-medlab.json',
    classCode: '308',
    papers: [
      { s: '11', subject: '臨床生理學與病理學',             tag: 'clinical_physio_path', name: '臨床生理學與病理學' },
      { s: '22', subject: '臨床血液學與血庫學',             tag: 'hematology',           name: '臨床血液學與血庫學' },
      { s: '33', subject: '醫學分子檢驗學與臨床鏡檢學',     tag: 'molecular',            name: '醫學分子檢驗學與臨床鏡檢學' },
      { s: '44', subject: '微生物學與臨床微生物學',         tag: 'microbiology',         name: '微生物學與臨床微生物學' },
      { s: '55', subject: '生物化學與臨床生化學',           tag: 'biochemistry',         name: '生物化學與臨床生化學' },
      { s: '66', subject: '臨床血清免疫學與臨床病毒學',     tag: 'serology',             name: '臨床血清免疫學與臨床病毒學' },
    ],
  },
  pt: {
    label: '物理治療師',
    file: 'questions-pt.json',
    classCode: '311',
    papers: [
      { s: '11', subject: '神經疾病物理治療學',             tag: 'pt_neuro',         name: '神經疾病物理治療學' },
      { s: '22', subject: '骨科疾病物理治療學',             tag: 'pt_ortho',         name: '骨科疾病物理治療學' },
      { s: '33', subject: '心肺疾病與小兒疾病物理治療學',   tag: 'pt_cardio_peds',   name: '心肺疾病與小兒疾病物理治療學' },
      { s: '44', subject: '物理治療基礎學',                 tag: 'pt_basic',         name: '物理治療基礎學' },
      { s: '55', subject: '物理治療學概論',                 tag: 'pt_intro',         name: '物理治療學概論' },
      { s: '66', subject: '物理治療技術學',                 tag: 'pt_technique',     name: '物理治療技術學' },
    ],
  },
  ot: {
    label: '職能治療師',
    file: 'questions-ot.json',
    classCode: '312',
    papers: [
      { s: '11', subject: '解剖學與生理學',                 tag: 'ot_anatomy',   name: '解剖學與生理學' },
      { s: '22', subject: '職能治療學概論',                 tag: 'ot_intro',     name: '職能治療學概論' },
      { s: '33', subject: '生理疾病職能治療學',             tag: 'ot_physical',  name: '生理疾病職能治療學' },
      { s: '44', subject: '心理疾病職能治療學',             tag: 'ot_mental',    name: '心理疾病職能治療學' },
      { s: '55', subject: '小兒疾病職能治療學',             tag: 'ot_pediatric', name: '小兒疾病職能治療學' },
      { s: '66', subject: '職能治療技術學',                 tag: 'ot_technique', name: '職能治療技術學' },
    ],
  },
}

// ─── 目標場次（year × session → code 列表）───
// 根據 probe 結果建立
const TARGETS = {
  doctor1: [
    // 106-107: only second session available (first session not on MoEX)
    { year: '106', session: '第二次', code: '106100' },
    { year: '107', session: '第二次', code: '107100' },
    // 108-109: both sessions available (108 first=030, 109 first=020)
    { year: '108', session: '第一次', code: '108030' },
    { year: '108', session: '第二次', code: '108100' },
    { year: '109', session: '第一次', code: '109020' },
    { year: '109', session: '第二次', code: '109100' },
    { year: '110', session: '第二次', code: '110101' },
  ],
  doctor2: [
    { year: '106', session: '第一次', code: '106020' },
    { year: '106', session: '第二次', code: '106080' },
    { year: '107', session: '第一次', code: '107020' },
    { year: '107', session: '第二次', code: '107080' },
    { year: '108', session: '第一次', code: '108030' },
    { year: '108', session: '第二次', code: '108080' },
    { year: '109', session: '第一次', code: '109020' },
    { year: '109', session: '第二次', code: '109080' },
    { year: '110', session: '第二次', code: '110080' },
    { year: '111', session: '第二次', code: '111080' },
    { year: '112', session: '第二次', code: '112080' },
  ],
  dental1: [
    { year: '106', session: '第一次', code: '106020' },
    { year: '106', session: '第二次', code: '106100' },
    { year: '107', session: '第一次', code: '107020' },
    { year: '107', session: '第二次', code: '107100' },
    { year: '108', session: '第一次', code: '108030' },
    { year: '108', session: '第二次', code: '108100' },
    { year: '109', session: '第一次', code: '109020' },
    { year: '109', session: '第二次', code: '109100' },
    { year: '110', session: '第二次', code: '110101' },
  ],
  dental2: [
    { year: '106', session: '第一次', code: '106020' },
    { year: '106', session: '第二次', code: '106100' },
    { year: '107', session: '第一次', code: '107020' },
    { year: '107', session: '第二次', code: '107100' },
    { year: '108', session: '第一次', code: '108030' },
    { year: '108', session: '第二次', code: '108100' },
    { year: '109', session: '第一次', code: '109020' },
    { year: '109', session: '第二次', code: '109100' },
    { year: '110', session: '第二次', code: '110100' },
  ],
  pharma1: [
    { year: '106', session: '第一次', code: '106020' },
    { year: '106', session: '第二次', code: '106100' },
    { year: '107', session: '第一次', code: '107020' },
    { year: '107', session: '第二次', code: '107100' },
    { year: '108', session: '第一次', code: '108030' },
    { year: '108', session: '第二次', code: '108100' },
    { year: '109', session: '第一次', code: '109020' },
    { year: '109', session: '第二次', code: '109100' },
    { year: '110', session: '第二次', code: '110101' },
  ],
  pharma2: [
    { year: '106', session: '第一次', code: '106020' },
    { year: '106', session: '第二次', code: '106100' },
    { year: '107', session: '第一次', code: '107020' },
    { year: '107', session: '第二次', code: '107100' },
    { year: '108', session: '第一次', code: '108030' },
    { year: '108', session: '第二次', code: '108100' },
    { year: '109', session: '第一次', code: '109020' },
    { year: '109', session: '第二次', code: '109100' },
    { year: '110', session: '第二次', code: '110100' },
  ],
  medlab: [
    { year: '106', session: '第一次', code: '106020' },
    { year: '106', session: '第二次', code: '106100' },
    { year: '107', session: '第一次', code: '107020' },
    { year: '107', session: '第二次', code: '107100' },
    { year: '108', session: '第一次', code: '108030' },
    { year: '108', session: '第二次', code: '108100' },
    { year: '109', session: '第一次', code: '109020' },
    { year: '109', session: '第二次', code: '109100' },
    { year: '110', session: '第一次', code: '110020' },
    { year: '110', session: '第二次', code: '110100' },
    { year: '111', session: '第一次', code: '111020' },
    { year: '111', session: '第二次', code: '111100' },
    { year: '112', session: '第一次', code: '112020' },
    { year: '112', session: '第二次', code: '112100' },
    { year: '113', session: '第一次', code: '113020' },
    { year: '113', session: '第二次', code: '113090' },
  ],
  pt: [
    { year: '106', session: '第一次', code: '106020' },
    { year: '106', session: '第二次', code: '106100' },
    { year: '107', session: '第一次', code: '107020' },
    { year: '107', session: '第二次', code: '107100' },
    { year: '108', session: '第一次', code: '108030' },
    { year: '108', session: '第二次', code: '108100' },
    { year: '109', session: '第一次', code: '109020' },
    { year: '109', session: '第二次', code: '109100' },
    { year: '110', session: '第一次', code: '110020' },
    { year: '110', session: '第二次', code: '110101' },
    { year: '111', session: '第一次', code: '111020' },
    { year: '111', session: '第二次', code: '111100' },
    { year: '112', session: '第一次', code: '112020' },
    { year: '112', session: '第二次', code: '112100' },
    { year: '113', session: '第一次', code: '113020' },
    { year: '113', session: '第二次', code: '113090' },
  ],
  ot: [
    { year: '106', session: '第一次', code: '106020' },
    { year: '106', session: '第二次', code: '106100' },
    { year: '107', session: '第一次', code: '107020' },
    { year: '107', session: '第二次', code: '107100' },
    { year: '108', session: '第一次', code: '108030' },
    { year: '108', session: '第二次', code: '108100' },
    { year: '109', session: '第一次', code: '109020' },
    { year: '109', session: '第二次', code: '109100' },
    { year: '110', session: '第二次', code: '110100' },
    { year: '111', session: '第二次', code: '111100' },
    { year: '112', session: '第二次', code: '112100' },
    { year: '113', session: '第二次', code: '113090' },
  ],
}

const BASE_URL = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'

function buildUrl(type, code, classCode, s) {
  return `${BASE_URL}?t=${type}&code=${code}&c=${classCode}&s=${s}&q=1`
}

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false,
      timeout: 20000,
      headers: { 'User-Agent': UA, 'Accept': 'application/pdf,*/*', 'Referer': 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location
        if (!loc || !loc.startsWith('http')) { res.resume(); return reject(new Error(`Redirect ${loc}`)) }
        return fetchPdf(loc, retries).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 1000)
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      const ct = res.headers['content-type'] || ''
      if (!ct.includes('pdf') && !ct.includes('octet')) { res.resume(); return reject(new Error(`Not PDF: ${ct}`)) }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', (e) => {
      if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 1000)
      reject(e)
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function extractText(buf) {
  const d = await pdfParse(buf)
  return d.text
}

// ─── Question parser (更穩健版本，修復掉題 bug) ───
function parseQuestions(text) {
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
    // Skip headers/footers
    if (/^(代\s*號|類\s*科|科\s*目|考試|頁次|等\s*別|全.*題|本試題|座號|※|【|】)/.test(line)) continue
    if (/^第?\s*\d+\s*頁/.test(line)) continue

    // Question number: must start with digit followed by . or 、 or ．
    // Reject decimal numbers (1.0, 2.5) — require CJK/letter/space after the dot
    const qMatch = line.match(/^(\d{1,3})[.、．]\s*(.*)$/)
    if (qMatch) {
      const num = parseInt(qMatch[1])
      const rest = (qMatch[2] || '').trim()
      // Accept if: (a) first question when no currentQ, OR (b) sequential (num = current+1)
      // Also require that rest has CJK/letter content (or is empty — continuation line case)
      const looksLikeQ = rest === '' || /[\u4e00-\u9fff a-zA-Z（(]/.test(rest)
      const isFirst = !currentQ && questions.length === 0
      const isNext = currentQ && num === currentQ.number + 1
      if (looksLikeQ && num >= 1 && num <= 99 && (isFirst || isNext)) {
        flushQ()
        currentQ = { number: num, question: rest, options: {} }
        continue
      }
    }

    // Option line
    const optMatch = line.match(/^[（(]?\s*([A-Da-dＡＢＣＤ])\s*[)）]?\s*[.\s]?\s*(.*)$/)
    if (optMatch && currentQ) {
      const letter = optMatch[1]
        .toUpperCase()
        .replace('Ａ','A').replace('Ｂ','B').replace('Ｃ','C').replace('Ｄ','D')
      flushOpt()
      currentOpt = letter
      buffer = optMatch[2] || ''
      continue
    }

    // Continuation
    if (currentOpt) buffer += ' ' + line
    else if (currentQ) currentQ.question += ' ' + line
  }
  flushQ()
  return questions
}

// ─── Answer parser ───
function parseAnswers(text) {
  const answers = {}
  // Method 1: full-width consecutive after "答案"
  const fw = /答案\s*([ＡＢＣＤ#＃]+)/g
  let m
  let n = 1
  while ((m = fw.exec(text)) !== null) {
    for (const ch of m[1]) {
      const map = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (map) answers[n++] = map
    }
  }
  if (Object.keys(answers).length >= 20) return answers
  // Method 2: "1.C 2.A" pattern
  const hw = /(\d{1,3})\s*[.、．:：]\s*([A-Da-d])/g
  while ((m = hw.exec(text)) !== null) {
    const num = parseInt(m[1])
    if (num >= 1 && num <= 120) answers[num] = m[2].toUpperCase()
  }
  return answers
}

function parseCorrections(text) {
  const corrections = {}
  for (const line of text.split(/\n/)) {
    const gp = line.match(/第?\s*(\d{1,3})\s*題.*(?:一律給分|送分)/i)
    if (gp) { corrections[parseInt(gp[1])] = '*'; continue }
    const cg = line.match(/第?\s*(\d{1,3})\s*題.*更正.*([A-D])/i)
    if (cg) { corrections[parseInt(cg[1])] = cg[2]; continue }
  }
  return corrections
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ─── Main scraper logic ───
async function scrapeExam(examId, filterYear, filterSession, dryRun) {
  const def = OLD_EXAM_DEFS[examId]
  if (!def) { console.error(`Unknown exam: ${examId}`); return [] }

  const targets = (TARGETS[examId] || []).filter(t =>
    (!filterYear || t.year === filterYear) &&
    (!filterSession || t.session === filterSession)
  )

  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ${def.label} (${examId}) — ${targets.length} sessions`)
  console.log(`${'='.repeat(60)}`)

  const results = []

  for (const t of targets) {
    console.log(`\n--- ${t.year}年${t.session} (code=${t.code}) ---`)
    for (const p of def.papers) {
      const qUrl = buildUrl('Q', t.code, def.classCode, p.s)
      const aUrl = buildUrl('S', t.code, def.classCode, p.s)
      const mUrl = buildUrl('M', t.code, def.classCode, p.s)

      if (dryRun) { console.log(`  Q: ${qUrl}`); continue }

      let qText
      try {
        const buf = await fetchPdf(qUrl)
        qText = await extractText(buf)
      } catch (e) {
        console.log(`  ✗ ${p.name}: ${e.message}`)
        continue
      }

      let answers = {}
      try {
        const aBuf = await fetchPdf(aUrl)
        answers = parseAnswers(await extractText(aBuf))
      } catch (e) {
        console.log(`  ⚠ ${p.name}: no answer PDF (${e.message})`)
      }

      let corrections = {}
      try {
        const mBuf = await fetchPdf(mUrl)
        corrections = parseCorrections(await extractText(mBuf))
      } catch {}

      for (const [n, a] of Object.entries(corrections)) {
        if (a !== '*') answers[n] = a
      }

      const parsed = parseQuestions(qText)
      console.log(`  ✓ ${p.name} (s=${p.s}): ${parsed.length} Q, ${Object.keys(answers).length} A`)

      for (const q of parsed) {
        const ans = answers[q.number]
        if (!ans) continue
        results.push({
          roc_year: t.year,
          session: t.session,
          exam_code: t.code,
          subject: p.subject,
          subject_tag: p.tag,
          subject_name: p.name,
          stage_id: 0,
          number: q.number,
          question: q.question.trim(),
          options: q.options,
          answer: ans === '*' ? (answers[q.number] || 'A') : ans,
          explanation: '',
          disputed: corrections[q.number] === '*' ? true : undefined,
        })
      }
      await sleep(300)
    }
    await sleep(500)
  }

  return results
}

// ─── Merge into existing JSON ───
function mergeIntoFile(examId, newQuestions) {
  const def = OLD_EXAM_DEFS[examId]
  const filePath = path.join(__dirname, '..', def.file)
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`)
    return
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  const existing = data.questions || data
  const isWrapped = !!data.questions

  // Find max id
  let maxId = 0
  for (const q of existing) {
    const numId = typeof q.id === 'number' ? q.id : parseInt(String(q.id).replace(/[^\d]/g, '')) || 0
    if (numId > maxId) maxId = numId
  }

  // Dedupe: skip if exam_code + subject + number already exists
  const existingKeys = new Set()
  for (const q of existing) {
    existingKeys.add(`${q.exam_code}|${q.subject}|${q.number}`)
  }

  let added = 0
  for (const q of newQuestions) {
    const key = `${q.exam_code}|${q.subject}|${q.number}`
    if (existingKeys.has(key)) continue
    existing.push({ id: ++maxId, ...q })
    added++
  }

  // Write back
  const output = isWrapped ? { ...data, total: existing.length, questions: existing } : existing
  fs.writeFileSync(filePath, JSON.stringify(output, null, 2), 'utf-8')
  console.log(`\n✅ ${def.label}: +${added} new questions → total ${existing.length} (${filePath})`)
  return added
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const noMerge = args.includes('--no-merge')
  const examIdx = args.indexOf('--exam')
  const yearIdx = args.indexOf('--year')
  const sessionIdx = args.indexOf('--session')
  const filterYear = yearIdx !== -1 ? args[yearIdx + 1] : null
  const filterSession = sessionIdx !== -1 ? args[sessionIdx + 1] : null
  const examId = examIdx !== -1 ? args[examIdx + 1] : null

  if (!examId) {
    console.log('Usage:')
    console.log('  node scripts/scrape-moex-old.js --exam all')
    console.log('  node scripts/scrape-moex-old.js --exam doctor1 --year 110')
    console.log('  node scripts/scrape-moex-old.js --exam medlab --dry-run --no-merge')
    console.log('\nAvailable exams:')
    for (const [id, d] of Object.entries(OLD_EXAM_DEFS)) {
      console.log(`  ${id.padEnd(10)} ${d.label} (c=${d.classCode}, ${d.papers.length} papers)`)
    }
    return
  }

  const exams = examId === 'all' ? Object.keys(OLD_EXAM_DEFS) : [examId]
  let grandTotal = 0
  for (const id of exams) {
    const qs = await scrapeExam(id, filterYear, filterSession, dryRun)
    if (!dryRun && !noMerge && qs.length > 0) {
      const added = mergeIntoFile(id, qs)
      grandTotal += added || 0
    } else if (!dryRun) {
      grandTotal += qs.length
      console.log(`  (skipped merge, ${qs.length} questions in memory)`)
    }
  }
  console.log(`\n${'='.repeat(60)}\nGrand total added: ${grandTotal}\n${'='.repeat(60)}`)
}

main().catch(e => { console.error(e); process.exit(1) })
