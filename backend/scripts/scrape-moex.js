#!/usr/bin/env node
/**
 * 考選部國考題庫爬蟲
 * 從 wwwq.moex.gov.tw 下載試題/答案 PDF 並解析為 JSON
 *
 * Usage:
 *   node scripts/scrape-moex.js --exam nursing
 *   node scripts/scrape-moex.js --exam all
 *   node scripts/scrape-moex.js --exam nursing --year 114
 *   node scripts/scrape-moex.js --dry-run --exam pt   # 列出 URL 不下載
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const { atomicWriteJson, withLock } = require('./lib/atomic-write')
const { loadSchema, deriveTagsFromSubjectName, validateTags } = require('./lib/shared-bank-schema')
const { parseColumnAware, parseAnswersColumnAware, parseAnswersText } = require('./lib/moex-column-parser')

let pdfParse
try { pdfParse = require('pdf-parse') } catch { /* optional */ }

const SHARED_BANKS_DIR = path.join(__dirname, '..', 'shared-banks')
const VALID_LEVELS = new Set(['license', 'senior', 'junior', 'elementary'])

// ─── 考試定義 ───
// classCode = 類科代碼, subjects = [{s, name, tag}]
// series = 該考試出現在哪些場次代碼系列 ('030' | '020' | '090')
// 注意：某些科目代碼隨場次不同而異（如 medlab 的基礎科）
const EXAM_DEFS = {
  nursing: {
    label: '護理師',
    classCode: '101',
    series: ['030'],
    subjects: [
      { s: '0101', name: '基礎醫學', tag: 'basic_medicine' },
      { s: '0102', name: '基本護理學與護理行政', tag: 'basic_nursing' },
      { s: '0103', name: '內外科護理學', tag: 'med_surg' },
      { s: '0104', name: '產兒科護理學', tag: 'obs_ped' },
      { s: '0105', name: '精神科與社區衛生護理學', tag: 'psych_community' },
    ],
  },
  nutrition: {
    label: '營養師',
    classCode: '102',
    series: ['030'],
    subjects: [
      { s: '0201', name: '膳食療養學', tag: 'diet_therapy' },
      { s: '0202', name: '團體膳食設計與管理', tag: 'group_meal' },
      { s: '0203', name: '生理學與生物化學', tag: 'physio_biochem' },
      { s: '0204', name: '營養學', tag: 'nutrition_science' },
      { s: '0205', name: '公共衛生營養學', tag: 'public_nutrition' },
      { s: '0206', name: '食品衛生與安全', tag: 'food_safety' },
    ],
  },
  medlab: {
    label: '醫事檢驗師',
    classCode: '308',
    series: ['020', '090'],
    // 基礎科的 subject code 隨場次不同：020→0107, 090→0103
    subjectsByCode: {
      '020': [
        { s: '0107', name: '臨床生理學與病理學', tag: 'clinical_physio_path' },
        { s: '0501', name: '臨床血液學與血庫學', tag: 'hematology' },
        { s: '0502', name: '醫學分子檢驗學與臨床鏡檢學', tag: 'molecular' },
        { s: '0503', name: '微生物學與臨床微生物學', tag: 'microbiology' },
        { s: '0504', name: '生物化學與臨床生化學', tag: 'biochemistry' },
        { s: '0505', name: '臨床血清免疫學與臨床病毒學', tag: 'serology' },
      ],
      '090': [
        { s: '0103', name: '臨床生理學與病理學', tag: 'clinical_physio_path' },
        { s: '0501', name: '臨床血液學與血庫學', tag: 'hematology' },
        { s: '0502', name: '醫學分子檢驗學與臨床鏡檢學', tag: 'molecular' },
        { s: '0503', name: '微生物學與臨床微生物學', tag: 'microbiology' },
        { s: '0504', name: '生物化學與臨床生化學', tag: 'biochemistry' },
        { s: '0505', name: '臨床血清免疫學與臨床病毒學', tag: 'serology' },
      ],
    },
  },
  pt: {
    label: '物理治療師',
    classCode: '311',
    series: ['020', '090'],
    subjects: [
      { s: '0701', name: '神經疾病物理治療學', tag: 'pt_neuro' },
      { s: '0702', name: '骨科疾病物理治療學', tag: 'pt_ortho' },
      { s: '0703', name: '心肺疾病與小兒疾病物理治療學', tag: 'pt_cardio_peds' },
      { s: '0704', name: '物理治療基礎學', tag: 'pt_basic' },
      { s: '0705', name: '物理治療學概論', tag: 'pt_intro' },
      { s: '0706', name: '物理治療技術學', tag: 'pt_technique' },
    ],
  },
  ot: {
    label: '職能治療師',
    classCode: '312',
    series: ['090'],   // OT 僅在第二次場次出現
    subjects: [
      { s: '0105', name: '解剖學與生理學', tag: 'ot_anatomy' },
      { s: '0801', name: '職能治療學概論', tag: 'ot_intro' },
      { s: '0802', name: '生理疾病職能治療學', tag: 'ot_physical' },
      { s: '0803', name: '心理疾病職能治療學', tag: 'ot_mental' },
      { s: '0804', name: '小兒疾病職能治療學', tag: 'ot_pediatric' },
      { s: '0805', name: '職能治療技術學', tag: 'ot_technique' },
    ],
  },
}

// ─── 考選部場次代碼 ───
// 格式: {ROC年}{序號}0
// 030 系列 = 護理師/營養師（護理 110-115 有效，營養 112/114/115 有效，113 缺）
// 020 系列 = 醫檢/物治（僅 114/115 有效，舊年度未上線電子系統）
// 090 系列 = 職治 + 醫檢/物治第二次（僅 114 有效）
// 注意：失效的 code 會被爬蟲 gracefully skip（302 redirect → catch）
const SESSION_CODES = {
  '030': {
    '110': ['110030'],
    '111': ['111030'],
    '112': ['112030'],
    // '113': 護理/營養均無資料
    '114': ['114030'],
    '115': ['115030'],
  },
  '020': {
    // 110-113: 物治/醫檢未上線
    '114': ['114020'],
    '115': ['115020'],
  },
  '090': {
    '114': ['114090'],
    // 115 第二次尚未舉行
  },
}

const BASE_URL = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// ─── HTTP helpers ───

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const opts = {
      rejectUnauthorized: false,
      timeout: 20000,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/pdf,*/*',
        'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx',
      },
    }
    const req = https.get(url, opts, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        let loc = res.headers.location
        if (loc && !loc.startsWith('http')) {
          // Relative redirect — likely an error page
          res.resume()
          return reject(new Error(`Redirect to ${loc}`))
        }
        return fetchPdf(loc, retries).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        if (retries > 0) {
          return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 1000)
        }
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      const contentType = res.headers['content-type'] || ''
      if (!contentType.includes('pdf') && !contentType.includes('octet')) {
        res.resume()
        return reject(new Error(`Not PDF: ${contentType}`))
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', (e) => {
      if (retries > 0) {
        return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 1000)
      }
      reject(e)
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function buildUrl(type, code, classCode, subjectCode) {
  return `${BASE_URL}?t=${type}&code=${code}&c=${classCode}&s=${subjectCode}&q=1`
}

// ─── PDF Parsing ───

async function extractTextFromPdf(buffer) {
  if (!pdfParse) throw new Error('pdf-parse not installed. Run: npm install pdf-parse')
  const data = await pdfParse(buffer)
  return data.text
}

/**
 * 解析試題 PDF → 題目陣列
 */
function parseQuestionsPdf(text) {
  const questions = []
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  let currentQ = null
  let currentOption = null
  let buffer = ''

  function flushOption() {
    if (currentQ && currentOption) {
      currentQ.options[currentOption] = buffer.trim()
    }
    buffer = ''
    currentOption = null
  }

  function flushQuestion() {
    flushOption()
    if (currentQ && currentQ.question && Object.keys(currentQ.options).length >= 2) {
      questions.push(currentQ)
    }
    currentQ = null
  }

  let inMcSection = false  // becomes true after we see "測驗題" header

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    // Skip header/footer
    if (/^(代號|類科|科目|考試|頁次|等\s*別|全.*題|本試題|座號|※)/.test(line)) continue
    if (/^\d+\s*頁/.test(line)) continue
    if (/^第\s*\d+\s*頁/.test(line)) continue

    // Detect 測驗題 / 選擇題 section marker (some PDFs have 申論題 essays before MC)
    // When found, drop any in-progress essay question so the MC Q1 is treated as first.
    if (/測驗題|單一選擇題|選擇題/.test(line) && !inMcSection) {
      currentQ = null
      currentOption = null
      buffer = ''
      inMcSection = true
      continue
    }

    // New question — number followed by period
    // Reject pure decimal numbers like "1.0", "2.5" (short line, no CJK/letters)
    const qMatch = line.match(/^(\d{1,2})[.、．]\s*(.*)$/)
    if (qMatch && (line.length > 6 || /[\u4e00-\u9fff a-zA-Z]/.test(qMatch[2] || '') || (qMatch[2] || '') === '')) {
      const num = parseInt(qMatch[1])
      // Accept sequential question numbers; only allow num=1 if no questions parsed yet
      const isFirst = !currentQ && questions.length === 0
      if (num >= 1 && num <= 80 && (isFirst || (currentQ && num === currentQ.number + 1))) {
        flushQuestion()
        currentQ = { number: num, question: (qMatch[2] || '').trim(), options: {} }
        continue
      }
    }

    // Option line — must have an explicit separator (period/punct or paren)
    // otherwise option text starting with A-D ("atorvastatin", "Cat scratch")
    // would be misparsed as a new option marker, dropping the leading letter.
    const optMatch = line.match(/^[\(（]\s*([A-Da-dＡＢＣＤ])\s*[\)）]\s*(.*)$/)
      || line.match(/^([A-Da-dＡＢＣＤ])\s*[.．、]\s*(.*)$/)
    if (optMatch && currentQ) {
      flushOption()
      currentOption = optMatch[1].toUpperCase()
        .replace('Ａ', 'A').replace('Ｂ', 'B').replace('Ｃ', 'C').replace('Ｄ', 'D')
      buffer = optMatch[2] || ''
      continue
    }

    // Continuation
    if (currentOption) {
      buffer += ' ' + line
    } else if (currentQ) {
      currentQ.question += ' ' + line
    }
  }
  flushQuestion()
  return questions
}

/**
 * 解析答案 PDF → { questionNumber: answer }
 * 考選部答案 PDF 格式（電腦化測驗後）：
 *   答案ＣＡＡＣＢＤ...  （連續全形字母，每 20 題一行）
 *   答案ＣＤＢＡＡＣ...
 * 或舊版格式：1.C 2.A 3.B ...
 */
function parseAnswersPdf(text) {
  const answers = {}

  // Method 1: consecutive full-width answers after "答案"
  // 找所有「答案」後接的連續全形字母行
  const fullWidthPattern = /答案\s*([ＡＢＣＤ]+)/g
  let fwMatch
  let questionNum = 1
  while ((fwMatch = fullWidthPattern.exec(text)) !== null) {
    const letters = fwMatch[1]
    for (let i = 0; i < letters.length; i++) {
      const ch = letters[i]
      const mapped = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (mapped) {
        answers[questionNum++] = mapped
      }
    }
  }

  if (Object.keys(answers).length >= 20) return answers

  // Method 2: half-width pattern  1.C  2.A  etc
  const hwPattern = /(\d{1,2})\s*[.\s、．:：]\s*([A-Da-d])/g
  let hwMatch
  while ((hwMatch = hwPattern.exec(text)) !== null) {
    const num = parseInt(hwMatch[1])
    if (num >= 1 && num <= 80) {
      answers[num] = hwMatch[2].toUpperCase()
    }
  }

  return answers
}

/**
 * 解析更正答案 PDF
 */
function parseCorrectionsPdf(text) {
  const corrections = {}
  const lines = text.split(/\n/)
  for (const line of lines) {
    const givePoints = line.match(/第?\s*(\d{1,2})\s*題.*(?:一律給分|送分)/i)
    if (givePoints) {
      corrections[parseInt(givePoints[1])] = '*'
      continue
    }
    const changeAns = line.match(/第?\s*(\d{1,2})\s*題.*更正.*([A-D])/i)
    if (changeAns) {
      corrections[parseInt(changeAns[1])] = changeAns[2]
      continue
    }
    // Table format
    const simple = line.match(/(\d{1,2})\s+([A-D*])/gi)
    if (simple) {
      for (const s of simple) {
        const m = s.match(/(\d{1,2})\s+([A-D*])/i)
        if (m) corrections[parseInt(m[1])] = m[2].toUpperCase()
      }
    }
  }
  return corrections
}

// ─── Helper: get subjects for a given exam + series code ───

function getSubjects(def, seriesKey) {
  if (def.subjectsByCode && def.subjectsByCode[seriesKey]) {
    return def.subjectsByCode[seriesKey]
  }
  return def.subjects
}

// ─── Helper: determine series key from exam code ───

function getSeriesKey(examCode) {
  const suffix = examCode.slice(-3)  // last 3 digits
  if (suffix.startsWith('03') || suffix === '030') return '030'
  if (suffix.startsWith('02') || suffix === '020') return '020'
  if (suffix.startsWith('08') || suffix.startsWith('09') || suffix === '090' || suffix === '080') return '090'
  return suffix
}

// ─── Main scraping logic ───

async function scrapeExam(examId, filterYear, dryRun) {
  const def = EXAM_DEFS[examId]
  if (!def) {
    console.error(`Unknown exam: ${examId}`)
    return 0
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`  Scraping: ${def.label} (${examId})`)
  console.log(`${'='.repeat(60)}`)

  const allQuestions = []
  let nextId = 1

  // Collect all exam codes for this exam's series
  const examCodes = []
  for (const series of def.series) {
    const codesBySeries = SESSION_CODES[series] || {}
    for (const [year, codes] of Object.entries(codesBySeries)) {
      if (filterYear && year !== filterYear) continue
      for (const code of codes) {
        examCodes.push({ year, code, series })
      }
    }
  }

  console.log(`  Found ${examCodes.length} exam sessions to scrape`)

  for (const { year, code, series } of examCodes) {
    const subjects = getSubjects(def, series)
    const sessionLabel = code.endsWith('020') ? '第一次' :
                         code.endsWith('030') ? '第一次' :
                         '第二次'

    console.log(`\n--- ${year}年${sessionLabel} (${code}) ---`)

    for (const sub of subjects) {
      const qUrl = buildUrl('Q', code, def.classCode, sub.s)
      const aUrl = buildUrl('S', code, def.classCode, sub.s)
      const mUrl = buildUrl('M', code, def.classCode, sub.s)

      if (dryRun) {
        console.log(`  Q: ${qUrl}`)
        console.log(`  A: ${aUrl}`)
        continue
      }

      // Download question PDF
      let qText
      try {
        const qBuf = await fetchPdf(qUrl)
        qText = await extractTextFromPdf(qBuf)
      } catch (e) {
        console.log(`  ✗ ${sub.name}: ${e.message}`)
        continue
      }

      // Download answer PDF
      let answers = {}
      try {
        const aBuf = await fetchPdf(aUrl)
        const aText = await extractTextFromPdf(aBuf)
        answers = parseAnswersPdf(aText)
      } catch (e) {
        console.log(`  ⚠ No answer PDF for ${sub.name}: ${e.message}`)
      }

      // Try corrections PDF (optional)
      let corrections = {}
      try {
        const mBuf = await fetchPdf(mUrl)
        const mText = await extractTextFromPdf(mBuf)
        corrections = parseCorrectionsPdf(mText)
        if (Object.keys(corrections).length > 0) {
          console.log(`  📝 ${sub.name}: ${Object.keys(corrections).length} corrections`)
        }
      } catch {
        // No corrections is normal
      }

      // Merge corrections
      for (const [num, ans] of Object.entries(corrections)) {
        if (ans === '*') {
          // 送分 — mark with asterisk, keep original answer
        } else {
          answers[num] = ans
        }
      }

      // Parse questions
      const parsed = parseQuestionsPdf(qText)
      console.log(`  ✓ ${sub.name}: ${parsed.length} questions, ${Object.keys(answers).length} answers`)

      // Defensive: strip mupdf PUA markers (U+E000..U+F8FF). MoEX PDFs use a
      // custom font whose A/B/C/D circled glyphs land in PUA and render as 口
      // boxes in the user's app font.
      const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s

      for (const q of parsed) {
        const ans = answers[q.number]
        if (!ans) continue

        const cleanOpts = {}
        for (const k of ['A', 'B', 'C', 'D']) cleanOpts[k] = stripPUA(q.options[k])

        // Determine paper (subject_name from config)
        allQuestions.push({
          id: nextId++,
          roc_year: year,
          session: sessionLabel,
          exam_code: code,
          subject: sub.name,
          subject_tag: sub.tag,
          subject_name: sub.name,
          stage_id: 0,
          number: q.number,
          question: stripPUA(q.question),
          options: cleanOpts,
          answer: ans === '*' ? (answers[q.number] || 'A') : ans,
          explanation: '',
          disputed: ans === '*' ? true : undefined,
        })
      }

      // Rate limiting
      await sleep(300)
    }

    await sleep(500)
  }

  if (dryRun) {
    console.log(`\n(Dry run — no files written)`)
    return 0
  }

  // Write output
  const outFile = path.join(__dirname, '..', `questions-${examId}.json`)
  const output = {
    metadata: {
      exam: examId,
      label: def.label,
      scraped_at: new Date().toISOString(),
      source: 'wwwq.moex.gov.tw',
    },
    total: allQuestions.length,
    questions: allQuestions,
  }
  withLock(outFile, () => atomicWriteJson(outFile, output))
  console.log(`\n✅ Wrote ${allQuestions.length} questions to ${outFile}`)
  return allQuestions.length
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ─── Shared bank scraping ───
//
// Generic mode for civil-service / law exams: takes raw MoEX params
// (--moex-code/-class/-subject) instead of relying on EXAM_DEFS, derives
// subject_tags from --paper via schema.md alias map (or accepts explicit
// --subject-tags), and merges into backend/shared-banks/<bankId>.json.
//
// Existing per-exam EXAM_DEFS path is untouched.

async function scrapeSharedBank(opts) {
  const {
    bankId, level, sourceExamName, sourceExamCode,
    moexCode, moexClass, moexSubject,
    paper, year, session,
    explicitTags, dryRun,
  } = opts

  const { whitelist, aliasMap } = loadSchema()

  // Resolve subject_tags: explicit > derive from paper name
  let subjectTags
  if (explicitTags && explicitTags.length) {
    subjectTags = validateTags(explicitTags, whitelist)
  } else {
    subjectTags = deriveTagsFromSubjectName(paper, aliasMap)
    if (subjectTags.length === 0) {
      throw new Error(
        `unknown subject "${paper}"; add to backend/shared-banks/schema.md ` +
        `or pass --subject-tags explicitly`
      )
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`  Shared bank: ${bankId}`)
  console.log(`  Source: ${sourceExamName} (${moexCode} c=${moexClass} s=${moexSubject})`)
  console.log(`  Paper: ${paper}  → tags: [${subjectTags.join(', ')}]`)
  console.log(`  Level: ${level}`)
  console.log(`${'='.repeat(60)}`)

  const qUrl = buildUrl('Q', moexCode, moexClass, moexSubject)
  const aUrl = buildUrl('S', moexCode, moexClass, moexSubject)

  if (dryRun) {
    console.log(`  Q: ${qUrl}`)
    console.log(`  A: ${aUrl}`)
    console.log(`  (Dry run — no fetch, no write)`)
    return 0
  }

  // Fetch + column-aware parse Q (civil-service combined papers have no A/B/C/D
  // labels in the PDF glyph layer; pdf-parse text mode loses the option boundaries
  // entirely, so we go through mupdf bbox reconstruction)
  const qBuf = await fetchPdf(qUrl)
  const parsedMap = await parseColumnAware(qBuf)
  const parsedNums = Object.keys(parsedMap).map(Number).sort((a, b) => a - b)

  // Fetch + parse A (try column-aware first for table-layout answer PDFs,
  // fall back to text regex for the old 答案ＣＡＡＣＢＤ layout)
  let answers = {}
  try {
    const aBuf = await fetchPdf(aUrl)
    try {
      answers = await parseAnswersColumnAware(aBuf)
    } catch { /* fall through */ }
    if (Object.keys(answers).length < 20) {
      const aText = await extractTextFromPdf(aBuf)
      answers = parseAnswersText(aText)
    }
  } catch (e) {
    console.log(`  ⚠ No answer PDF: ${e.message}`)
  }

  console.log(`  Parsed ${parsedNums.length} questions, ${Object.keys(answers).length} answers`)

  const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s

  const newQuestions = []
  for (const num of parsedNums) {
    const q = parsedMap[num]
    const ans = answers[num]
    if (!ans) continue
    const cleanOpts = {}
    for (const k of ['A', 'B', 'C', 'D']) cleanOpts[k] = stripPUA(q.options[k])
    newQuestions.push({
      id: `${bankId}-${year}-${sourceExamCode}-${num}`,
      roc_year: String(year),
      session,
      source_exam_code: sourceExamCode,
      source_exam_name: sourceExamName,
      subject: paper,
      subject_tags: subjectTags,
      number: num,
      question: stripPUA(q.question),
      options: cleanOpts,
      answer: ans,
      level,
      shared_bank: bankId,
      parent_id: null,
      case_context: null,
      is_deprecated: false,
      deprecated_reason: null,
    })
  }

  if (newQuestions.length === 0) {
    console.log('  ✗ No questions to merge (parse + answer match yielded 0)')
    return 0
  }

  // Merge into bank file
  if (!fs.existsSync(SHARED_BANKS_DIR)) fs.mkdirSync(SHARED_BANKS_DIR, { recursive: true })
  const bankFile = path.join(SHARED_BANKS_DIR, `${bankId}.json`)

  let bank
  if (fs.existsSync(bankFile)) {
    bank = JSON.parse(fs.readFileSync(bankFile, 'utf-8'))
  } else {
    bank = {
      bankId,
      name: bankId,
      description: '',
      bankVersion: 0,
      last_synced_at: null,
      levels: [],
      questions: [],
    }
  }

  // Dedupe by id (newer wins, so re-running a scrape replaces stale rows)
  const byId = new Map(bank.questions.map(q => [q.id, q]))
  let added = 0, replaced = 0
  for (const nq of newQuestions) {
    if (byId.has(nq.id)) replaced++; else added++
    byId.set(nq.id, nq)
  }
  bank.questions = Array.from(byId.values())
  bank.bankVersion = (bank.bankVersion || 0) + 1
  bank.last_synced_at = new Date().toISOString()
  if (!bank.levels.includes(level)) bank.levels.push(level)

  withLock(bankFile, () => atomicWriteJson(bankFile, bank))
  console.log(`\n✅ ${bankFile}`)
  console.log(`   +${added} new, ${replaced} replaced  (bank now ${bank.questions.length} total, v${bank.bankVersion})`)
  return added + replaced
}

function parseSharedBankArgs(args) {
  const get = (flag) => {
    const i = args.indexOf(flag)
    return i !== -1 ? args[i + 1] : null
  }
  const bankId = get('--shared-bank')
  if (!bankId) return null

  const level = get('--level') || 'senior'
  if (!VALID_LEVELS.has(level)) {
    throw new Error(`--level must be one of: ${[...VALID_LEVELS].join(', ')}`)
  }
  const sourceExamName = get('--source-exam-name')
  if (!sourceExamName) throw new Error('--source-exam-name is required')
  const sourceExamCode = get('--source-exam-code')
  if (!sourceExamCode) throw new Error('--source-exam-code is required')
  const moexCode = get('--moex-code')
  if (!moexCode) throw new Error('--moex-code is required (e.g. 114080)')
  const moexClass = get('--moex-class')
  if (!moexClass) throw new Error('--moex-class is required (MoEX c= param)')
  const moexSubject = get('--moex-subject')
  if (!moexSubject) throw new Error('--moex-subject is required (MoEX s= param)')
  const paper = get('--paper')
  if (!paper) throw new Error('--paper is required (Chinese paper name, e.g. 憲法)')
  const year = get('--year')
  if (!year) throw new Error('--year is required (ROC year, e.g. 114)')
  const session = get('--session') || '第一次'
  const explicitTagsRaw = get('--subject-tags')
  const explicitTags = explicitTagsRaw
    ? explicitTagsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : null

  return {
    bankId, level, sourceExamName, sourceExamCode,
    moexCode, moexClass, moexSubject,
    paper, year, session, explicitTags,
  }
}

// ─── CLI ───

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')

  // Shared bank mode short-circuits the per-exam EXAM_DEFS path
  const sb = parseSharedBankArgs(args)
  if (sb) {
    await scrapeSharedBank({ ...sb, dryRun })
    return
  }

  // Extract --year option
  const yearIdx = args.indexOf('--year')
  const filterYear = yearIdx !== -1 ? args[yearIdx + 1] : null

  if (args.includes('--list-urls')) {
    // Quick helper: list all URLs for all exams
    for (const [id, def] of Object.entries(EXAM_DEFS)) {
      console.log(`\n=== ${def.label} (${id}) ===`)
      for (const series of def.series) {
        const codes = SESSION_CODES[series] || {}
        for (const [year, yearCodes] of Object.entries(codes)) {
          for (const code of yearCodes) {
            const subjects = getSubjects(def, series)
            for (const sub of subjects) {
              console.log(`  ${year} ${code} ${sub.s} ${sub.tag}`)
            }
          }
        }
      }
    }
    return
  }

  const examIdx = args.indexOf('--exam')
  if (examIdx === -1) {
    console.log('考選部國考題庫爬蟲')
    console.log('')
    console.log('Usage:')
    console.log('  node scripts/scrape-moex.js --exam nursing|pt|ot|medlab|nutrition|all')
    console.log('  node scripts/scrape-moex.js --exam nursing --year 114')
    console.log('  node scripts/scrape-moex.js --dry-run --exam pt')
    console.log('  node scripts/scrape-moex.js --list-urls')
    console.log('')
    console.log('Shared bank mode (法律/公職 共享題庫):')
    console.log('  node scripts/scrape-moex.js \\')
    console.log('    --shared-bank common_constitution \\')
    console.log('    --level senior \\')
    console.log('    --source-exam-name "114 年高考三等一般行政" \\')
    console.log('    --source-exam-code senior-general \\')
    console.log('    --moex-code 114080 --moex-class 003 --moex-subject 0101 \\')
    console.log('    --paper 憲法 --year 114 [--session 第一次] [--subject-tags constitution]')
    console.log('')
    console.log('Available exams:')
    for (const [id, def] of Object.entries(EXAM_DEFS)) {
      console.log(`  ${id.padEnd(12)} ${def.label} (c=${def.classCode}, series=${def.series.join('+')})`)
    }
    return
  }

  const examId = args[examIdx + 1]
  if (examId === 'all') {
    let total = 0
    for (const id of Object.keys(EXAM_DEFS)) {
      total += await scrapeExam(id, filterYear, dryRun)
    }
    console.log(`\n${'='.repeat(60)}`)
    console.log(`  Total: ${total} questions scraped`)
  } else {
    await scrapeExam(examId, filterYear, dryRun)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
