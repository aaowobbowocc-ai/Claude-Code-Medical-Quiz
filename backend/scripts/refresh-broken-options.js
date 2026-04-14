#!/usr/bin/env node
/**
 * Surgical fix for the option-parser regex bug:
 * 1. Audits all questions-*.json for papers that contain ≥1 question with empty options
 * 2. For each affected paper, re-fetches Q+S+M PDFs from MoEX using EXAM_DEFS
 * 3. Re-parses with the fixed parser
 * 4. Replaces questions for that paper in-place, preserving id
 * 5. If fetch fails, logs and keeps existing data (no destructive overwrites)
 *
 * Only fixes exams supported by scrape-moex.js EXAM_DEFS:
 *   nursing, nutrition, medlab, pt, ot
 *
 * doctor1/2, dental1/2, pharma1/2 are not in EXAM_DEFS and need separate one-shot scripts.
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

// ─── Same EXAM_DEFS as scrape-moex.js ───
const EXAM_DEFS = {
  nursing: {
    label: '護理師', classCode: '101',
    // Class code varies by year/session: 110030/110110/111030 used 104,
    // 113030 uses 101 with 2-digit s codes, 112110/114100 use 102 with 0201+,
    // 114030+ uses 101 with 0101+. Cache + altClassCodes covers all.
    altClassCodes: ['102', '104'],
    subjects: [
      { sCodes: ['0101', '11'], name: '基礎醫學',                 tag: 'basic_medicine' },
      { sCodes: ['0102', '22'], name: '基本護理學與護理行政',     tag: 'basic_nursing' },
      { sCodes: ['0103', '33'], name: '內外科護理學',             tag: 'med_surg' },
      { sCodes: ['0104', '44'], name: '產兒科護理學',             tag: 'obs_ped' },
      { sCodes: ['0105', '55'], name: '精神科與社區衛生護理學',   tag: 'psych_community' },
    ],
  },
  nutrition: {
    label: '營養師', classCode: '102',
    // Older years (113100, 114100) used class code 101 with s=0101-0106;
    // newer (115030+) use 102 with s=0201-0206. The script checks the cache
    // first so old PDFs still work even though the URLs no longer do.
    altClassCodes: ['101'],
    subjects: [
      { sCodes: ['0201', '0101'], name: '膳食療養學',         tag: 'diet_therapy' },
      { sCodes: ['0202', '0102'], name: '團體膳食設計與管理', tag: 'group_meal' },
      { sCodes: ['0203', '0103'], name: '生理學與生物化學',   tag: 'physio_biochem' },
      { sCodes: ['0204', '0104'], name: '營養學',             tag: 'nutrition_science' },
      { sCodes: ['0205', '0105'], name: '公共衛生營養學',     tag: 'public_nutrition' },
      { sCodes: ['0206', '0106'], name: '食品衛生與安全',     tag: 'food_safety' },
    ],
  },
  medlab: {
    label: '醫事檢驗師', classCode: '308',
    subjects: [
      // sCodes: try every code in order until one returns the right PDF.
      // Old years (110-113) use 2-digit codes; new years (114+) use 4-digit.
      { sCodes: ['0107', '0103', '11'], name: '臨床生理學與病理學', tag: 'clinical_physio_path' },
      { sCodes: ['0501', '22'],         name: '臨床血液學與血庫學',         tag: 'hematology' },
      { sCodes: ['0502', '33'],         name: '醫學分子檢驗學與臨床鏡檢學', tag: 'molecular' },
      { sCodes: ['0503', '44'],         name: '微生物學與臨床微生物學',     tag: 'microbiology' },
      { sCodes: ['0504', '55'],         name: '生物化學與臨床生化學',       tag: 'biochemistry' },
      { sCodes: ['0505', '66'],         name: '臨床血清免疫學與臨床病毒學', tag: 'serology' },
    ],
  },
  pt: {
    label: '物理治療師', classCode: '311',
    subjects: [
      { sCodes: ['0701', '11'], name: '神經疾病物理治療學',           tag: 'pt_neuro' },
      { sCodes: ['0702', '22'], name: '骨科疾病物理治療學',           tag: 'pt_ortho' },
      { sCodes: ['0703', '33'], name: '心肺疾病與小兒疾病物理治療學', tag: 'pt_cardio_peds' },
      { sCodes: ['0704', '44'], name: '物理治療基礎學',               tag: 'pt_basic' },
      { sCodes: ['0705', '55'], name: '物理治療學概論',               tag: 'pt_intro' },
      { sCodes: ['0706', '66'], name: '物理治療技術學',               tag: 'pt_technique' },
    ],
  },
  ot: {
    label: '職能治療師', classCode: '312',
    subjects: [
      { sCodes: ['0105', '11'], name: '解剖學與生理學',         tag: 'ot_anatomy' },
      { sCodes: ['0801', '22'], name: '職能治療學概論',         tag: 'ot_intro' },
      { sCodes: ['0802', '33'], name: '生理疾病職能治療學',     tag: 'ot_physical' },
      { sCodes: ['0803', '44'], name: '心理疾病職能治療學',     tag: 'ot_mental' },
      { sCodes: ['0804', '55'], name: '小兒疾病職能治療學',     tag: 'ot_pediatric' },
      { sCodes: ['0805', '66'], name: '職能治療技術學',         tag: 'ot_technique' },
    ],
  },
}

// File ↔ exam mapping
const EXAM_FILES = {
  'questions-nursing.json': 'nursing',
  'questions-nutrition.json': 'nutrition',
  'questions-medlab.json': 'medlab',
  'questions-pt.json': 'pt',
  'questions-ot.json': 'ot',
}

const BASE_URL = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')

// Check the local PDF cache first using all known filename conventions.
// Returns Buffer or null. Falls back to HTTP fetch from caller.
function tryCache(examTag, kind, code, c, s) {
  const candidates = [
    `${examTag}_${kind}_${code}_c${c}_s${s}.pdf`, // new prefix: nutrition_Q_…
    `${examTag}_${code}_c${c}_s${s}.pdf`,         // legacy prefix: medlab_…
  ]
  for (const k of candidates) {
    const p = path.join(PDF_CACHE, k)
    if (fs.existsSync(p) && fs.statSync(p).size > 1000) return fs.readFileSync(p)
  }
  return null
}

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false,
      timeout: 25000,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/pdf,*/*',
        'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx',
      },
    }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        const loc = res.headers.location
        if (loc && !loc.startsWith('http')) { res.resume(); return reject(new Error(`Redirect to ${loc}`)) }
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
    req.on('error', e => {
      if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 1000)
      reject(e)
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function buildUrl(t, code, c, s) {
  return `${BASE_URL}?t=${t}&code=${code}&c=${c}&s=${s}&q=1`
}

// ─── Fixed parser (same as scrape-moex.js) ───
function parseQuestionsPdf(text) {
  const questions = []
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  let currentQ = null, currentOption = null, buffer = ''

  function flushOption() {
    if (currentQ && currentOption) currentQ.options[currentOption] = buffer.trim()
    buffer = ''; currentOption = null
  }
  function flushQuestion() {
    flushOption()
    if (currentQ && currentQ.question && Object.keys(currentQ.options).length >= 2) questions.push(currentQ)
    currentQ = null
  }

  let inMcSection = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^(代號|類科|科目|考試|頁次|等\s*別|全.*題|本試題|座號|※)/.test(line)) continue
    if (/^\d+\s*頁/.test(line) || /^第\s*\d+\s*頁/.test(line)) continue

    if (/測驗題|單一選擇題|選擇題/.test(line) && !inMcSection) {
      currentQ = null; currentOption = null; buffer = ''
      inMcSection = true
      continue
    }

    const qMatch = line.match(/^(\d{1,2})[.、．]\s*(.*)$/)
    if (qMatch && (line.length > 6 || /[\u4e00-\u9fff a-zA-Z]/.test(qMatch[2] || '') || (qMatch[2] || '') === '')) {
      const num = parseInt(qMatch[1])
      const isFirst = !currentQ && questions.length === 0
      if (num >= 1 && num <= 80 && (isFirst || (currentQ && num === currentQ.number + 1))) {
        flushQuestion()
        currentQ = { number: num, question: (qMatch[2] || '').trim(), options: {} }
        continue
      }
    }

    const optMatch = line.match(/^[\(（]\s*([A-Da-dＡＢＣＤ])\s*[\)）]\s*(.*)$/)
      || line.match(/^([A-Da-dＡＢＣＤ])\s*[.．、]\s*(.*)$/)
    if (optMatch && currentQ) {
      flushOption()
      currentOption = optMatch[1].toUpperCase()
        .replace('Ａ', 'A').replace('Ｂ', 'B').replace('Ｃ', 'C').replace('Ｄ', 'D')
      buffer = optMatch[2] || ''
      continue
    }

    if (currentOption) buffer += ' ' + line
    else if (currentQ) currentQ.question += ' ' + line
  }
  flushQuestion()
  return questions
}

function parseAnswersPdf(text) {
  const answers = {}
  const fullWidthPattern = /答案\s*([ＡＢＣＤ]+)/g
  let m, n = 1
  while ((m = fullWidthPattern.exec(text)) !== null) {
    for (const ch of m[1]) {
      const x = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (x) answers[n++] = x
    }
  }
  if (Object.keys(answers).length >= 20) return answers
  const hwPattern = /(\d{1,2})\s*[.\s、．:：]\s*([A-Da-d])/g
  let hw
  while ((hw = hwPattern.exec(text)) !== null) {
    const num = parseInt(hw[1])
    if (num >= 1 && num <= 80) answers[num] = hw[2].toUpperCase()
  }
  return answers
}

function parseCorrectionsPdf(text) {
  const corrections = {}
  for (const line of text.split(/\n/)) {
    const give = line.match(/第?\s*(\d{1,2})\s*題.*(?:一律給分|送分)/i)
    if (give) { corrections[parseInt(give[1])] = '*'; continue }
    const change = line.match(/第?\s*(\d{1,2})\s*題.*更正.*([A-D])/i)
    if (change) { corrections[parseInt(change[1])] = change[2]; continue }
    const simple = line.match(/(\d{1,2})\s+([A-D*])/gi)
    if (simple) for (const s of simple) {
      const mm = s.match(/(\d{1,2})\s+([A-D*])/i)
      if (mm) corrections[parseInt(mm[1])] = mm[2].toUpperCase()
    }
  }
  return corrections
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function tryFetchPaper(examTag, examCode, classCodes, subj, defLabel) {
  // sCodes is preferred (array); fall back to legacy s/altS pair
  const sCodes = subj.sCodes
    ? subj.sCodes
    : (subj.altS ? [subj.s, subj.altS] : [subj.s])
  // Try every (classCode, s) combination. Cache hit short-circuits the URL.
  for (const c of classCodes) {
    for (const s of sCodes) {
      try {
        let qBuf = tryCache(examTag, 'Q', examCode, c, s)
        if (!qBuf) qBuf = await fetchPdf(buildUrl('Q', examCode, c, s))
        const qText = (await pdfParse(qBuf)).text

        // Sanity check: PDF must have 類科名稱: <defLabel>. Just looking for
        // the bare word fails when the cover page lists every exam that day.
        if (defLabel) {
          const m = qText.match(/類\s*科\s*名?\s*稱?\s*[:：]\s*(\S+)/)
          const actualClass = m ? m[1] : null
          if (!actualClass || !actualClass.includes(defLabel)) continue
        }

        let answers = {}
        try {
          let aBuf = tryCache(examTag, 'S', examCode, c, s)
          if (!aBuf) aBuf = await fetchPdf(buildUrl('S', examCode, c, s))
          answers = parseAnswersPdf((await pdfParse(aBuf)).text)
        } catch {}

        let corrections = {}
        try {
          let mBuf = tryCache(examTag, 'M', examCode, c, s)
          if (!mBuf) mBuf = await fetchPdf(buildUrl('M', examCode, c, s))
          corrections = parseCorrectionsPdf((await pdfParse(mBuf)).text)
        } catch {}

        const disputedNums = new Set()
        for (const [num, ans] of Object.entries(corrections)) {
          if (ans === '*') disputedNums.add(parseInt(num))
          else answers[num] = ans
        }

        const parsed = parseQuestionsPdf(qText)
        return { parsed, answers, disputedNums, sUsed: s, cUsed: c }
      } catch (e) {
        // try next combo
      }
    }
  }
  return null
}

async function refreshFile(fname) {
  const examId = EXAM_FILES[fname]
  const def = EXAM_DEFS[examId]
  console.log(`\n${'='.repeat(60)}\n  ${fname} (${def.label})\n${'='.repeat(60)}`)

  const fpath = path.join(__dirname, '..', fname)
  const data = JSON.parse(fs.readFileSync(fpath, 'utf-8'))
  const isWrapped = !Array.isArray(data)
  const qs = isWrapped ? data.questions : data

  // Group by (exam_code, subject_tag), find broken papers
  const papers = new Map() // key: code|tag -> array of question indices
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i]
    const key = q.exam_code + '|' + q.subject_tag
    if (!papers.has(key)) papers.set(key, [])
    papers.get(key).push(i)
  }

  const brokenPapers = new Map()
  for (const [key, indices] of papers) {
    let hasBroken = false
    let maxNum = 0
    const nums = new Set()
    for (const idx of indices) {
      const opts = qs[idx].options || {}
      if (!opts.A?.trim() || !opts.B?.trim() || !opts.C?.trim() || !opts.D?.trim()) hasBroken = true
      const n = qs[idx].number
      if (typeof n === 'number') {
        nums.add(n)
        if (n > maxNum) maxNum = n
      }
    }
    // Has gap = max number > count (some numbers in 1..max are missing)
    const hasGap = maxNum > indices.length
    if (hasBroken || hasGap) brokenPapers.set(key, indices)
  }

  console.log(`Found ${brokenPapers.size} broken papers (out of ${papers.size} total)`)

  let fixedPapers = 0, fixedQuestions = 0, failedFetches = 0
  const failures = []

  for (const [key, indices] of brokenPapers) {
    const [examCode, subjectTag] = key.split('|')
    const subj = def.subjects.find(s => s.tag === subjectTag)
    if (!subj) {
      console.log(`  ⚠ ${key}: unknown subject tag, skipping`)
      continue
    }

    process.stdout.write(`  Refetching ${examCode} ${subj.name}... `)
    const allClassCodes = [def.classCode, ...(def.altClassCodes || [])]
    const result = await tryFetchPaper(examId, examCode, allClassCodes, subj, def.label)
    if (!result) {
      console.log(`✗ FAIL`)
      failedFetches++
      failures.push(`${examCode} ${subj.name}`)
      await sleep(300)
      continue
    }

    const { parsed, answers, disputedNums, sUsed, cUsed } = result
    // Accept if we got at least 80% of the expected number of questions in this paper
    const expected = indices.length
    if (parsed.length < Math.max(20, Math.floor(expected * 0.8))) {
      console.log(`✗ only ${parsed.length} parsed (expected ~${expected})`)
      failedFetches++
      failures.push(`${examCode} ${subj.name} (${parsed.length}/${expected})`)
      await sleep(300)
      continue
    }

    // Build map: number → fresh question
    const freshByNum = {}
    for (const p of parsed) {
      if (answers[p.number]) {
        freshByNum[p.number] = {
          ...p,
          answer: answers[p.number],
          disputed: disputedNums.has(p.number) || undefined,
        }
      }
    }

    // Build map: existing number → idx
    const oldByNum = {}
    for (const idx of indices) oldByNum[qs[idx].number] = idx

    // Template for new questions (copy non-content fields from any existing in this paper)
    const template = qs[indices[0]]

    // Determine next id: scan all numeric ids globally
    let maxNumericId = 0
    for (const q of qs) if (typeof q.id === 'number' && q.id > maxNumericId) maxNumericId = q.id

    let replaced = 0, added = 0
    for (const num of Object.keys(freshByNum).map(Number).sort((a,b)=>a-b)) {
      const fresh = freshByNum[num]
      if (oldByNum[num] !== undefined) {
        const idx = oldByNum[num]
        qs[idx] = {
          ...qs[idx],
          question: fresh.question,
          options: fresh.options,
          answer: fresh.answer,
        }
        if (fresh.disputed) qs[idx].disputed = true
        else delete qs[idx].disputed
        replaced++
      } else {
        // Add missing question, using next sequential id
        maxNumericId++
        const newQ = {
          id: maxNumericId,
          roc_year: template.roc_year,
          session: template.session,
          exam_code: template.exam_code,
          subject: template.subject,
          subject_tag: template.subject_tag,
          subject_name: template.subject_name,
          stage_id: template.stage_id ?? 0,
          number: num,
          question: fresh.question,
          options: fresh.options,
          answer: fresh.answer,
          explanation: '',
        }
        if (fresh.disputed) newQ.disputed = true
        qs.push(newQ)
        added++
      }
    }
    console.log(`✓ replaced ${replaced}, added ${added} (c=${cUsed} s=${sUsed})`)
    fixedPapers++
    fixedQuestions += replaced + added
    await sleep(400)
  }

  // Write back
  if (isWrapped) data.questions = qs
  if (data.metadata) data.metadata.last_updated = new Date().toISOString()
  fs.writeFileSync(fpath, JSON.stringify(data, null, 2), 'utf-8')

  console.log(`\nSummary for ${fname}:`)
  console.log(`  Fixed papers: ${fixedPapers}`)
  console.log(`  Refreshed questions: ${fixedQuestions}`)
  console.log(`  Failed fetches: ${failedFetches}`)
  if (failures.length > 0) console.log(`  Failures: ${failures.join(', ')}`)
}

async function main() {
  const argFile = process.argv[2]
  const files = argFile ? [argFile] : Object.keys(EXAM_FILES)
  for (const f of files) {
    if (!EXAM_FILES[f]) { console.error(`Unknown file: ${f}`); continue }
    await refreshFile(f)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
