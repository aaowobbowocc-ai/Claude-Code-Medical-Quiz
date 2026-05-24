#!/usr/bin/env node
// Scrape 教師資格考試 (Teacher Qualification Assessment) — all 類科.
//
// Source: https://tqa.rcpet.edu.tw/TEA_Exam/TEA03.aspx (教育部高級中等以下
// 學校及幼兒園教師資格考試「樣卷、歷屆試題及參考答案」). NOT 考選部.
//
// The page is ASP.NET WebForms. Flow per year + 類科:
//   1. GET TEA03.aspx           → grab __VIEWSTATE / __EVENTVALIDATION
//   2. POST schyy=<year>        → postback populates the 檢定類科 (exid) dropdown
//   3. POST exid=<類科代碼>     → renders the 試題/參考答案 table
// Each subject row has a 考題 PDF link + a 參考答案 PDF link, both served via
// ShowPicOut2.aspx?ASParam=<encrypted> — the param is session-bound, so the
// listing must be re-fetched each run (no stable URLs to cache).
// IMPORTANT: the postback MUST include __LASTFOCUS and __VIEWSTATEENCRYPTED
// (empty) or the server 302-redirects to Error.html.
//
// Every 類科 shares 4 教育專業/共同 subjects, each with 25 single-choice
// questions (選擇題), followed by 非選擇題/綜合題/寫作 sections we skip:
//   國語文能力測驗       — 全類科 shared paper; 5 reading passages × 5 questions
//   教育理念與實務       — 類科-specific standalone MCQ
//   學習者發展與適性輔導 — 類科-specific standalone MCQ
//   課程教學與評量       — 類科-specific standalone MCQ
// 國民小學 additionally has 數學能力測驗 — SKIPPED: it carries fractions and
// geometry figures that need LaTeX/image support the platform lacks.
// 教師資格考試 is held once a year → session is always 第一次.
//
// 110 年起為現行「教師資格考試」(4-subject structure). 094-109 是舊制
// 「教師資格檢定考試」(different subjects) — out of scope here.
//
// Usage: node scripts/scrape-teacher.js [--exam <id>] [--year 114] [--dry-run]

const https = require('https')
const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')

const BASE = 'https://tqa.rcpet.edu.tw/TEA_Exam/'
const PAGE = BASE + 'TEA03.aspx'
const YEARS = ['110', '111', '112', '113', '114']
const SY = 'ctl00$ContentPlaceHolder1$schyy'
const EX = 'ctl00$ContentPlaceHolder1$exid'
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 4 subjects common to every 類科 — listing-table row order. (國民小學 also has
// 數學能力測驗; intentionally omitted, see header note.)
const SUBJECTS = [
  { code: 1, id: 'chinese',        name: '國語文能力測驗',       passages: true },
  { code: 2, id: 'edu_principles', name: '教育理念與實務',       passages: false },
  { code: 3, id: 'learner_dev',    name: '學習者發展與適性輔導', passages: false },
  { code: 4, id: 'curriculum',     name: '課程教學與評量',       passages: false },
]

// One entry per platform exam. classLabel is the 類科 string the subject PDFs
// carry — used as an identity guard against grabbing the wrong PDF.
const EXAMS = {
  'teacher-secondary':       { exid: '40', classLabel: '中等學校', label: '中等學校' },
  'teacher-elementary':      { exid: '30', classLabel: '國民小學', label: '國民小學' },
  'teacher-kindergarten':    { exid: '10', classLabel: '幼兒園',   label: '幼兒園' },
  'teacher-special':         { exid: '21', classLabel: '特殊教育', label: '特殊教育（身心障礙組）' },
  'teacher-special-gifted':  { exid: '22', classLabel: '特殊教育', label: '特殊教育（資賦優異組）' },
}

// ── HTTP ────────────────────────────────────────────────────────────────
function request(method, url, { headers = {}, data } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const body = data ? Buffer.from(data, 'utf8') : null
    const h = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'zh-TW', ...headers }
    if (body) {
      h['Content-Type'] = 'application/x-www-form-urlencoded'
      h['Content-Length'] = body.length
    }
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers: h },
      res => {
        const chunks = []
        res.on('data', d => chunks.push(d))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      }
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

const enc = encodeURIComponent
const formData = obj => Object.entries(obj).map(([k, v]) => enc(k) + '=' + enc(v)).join('&')

function hiddenField(html, name) {
  const re = new RegExp('name="' + name.replace(/\$/g, '\\$') + '"[^>]*value="([^"]*)"')
  const m = html.match(re)
  return m ? m[1] : ''
}

// Fetch the 試題 listing for a given year + 類科, return [{subject, qPdf, aPdf}].
async function fetchListing(year, exam) {
  let r = await request('GET', PAGE)
  let html = r.body.toString('utf8')
  const cookie = (r.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ')
  let vs = hiddenField(html, '__VIEWSTATE')
  let vsg = hiddenField(html, '__VIEWSTATEGENERATOR')
  let ev = hiddenField(html, '__EVENTVALIDATION')

  // Postback — select year (populates the exid dropdown)
  r = await request('POST', PAGE, {
    headers: { Cookie: cookie, Referer: PAGE },
    data: formData({
      __EVENTTARGET: SY, __EVENTARGUMENT: '', __LASTFOCUS: '',
      __VIEWSTATE: vs, __VIEWSTATEGENERATOR: vsg, __VIEWSTATEENCRYPTED: '', __EVENTVALIDATION: ev,
      [SY]: year, [EX]: '',
    }),
  })
  html = r.body.toString('utf8')
  if (r.status !== 200) throw new Error(`year postback ${year}: HTTP ${r.status}`)
  vs = hiddenField(html, '__VIEWSTATE')
  vsg = hiddenField(html, '__VIEWSTATEGENERATOR')
  ev = hiddenField(html, '__EVENTVALIDATION')

  // Postback — select 類科 (renders the question table)
  r = await request('POST', PAGE, {
    headers: { Cookie: cookie, Referer: PAGE },
    data: formData({
      __EVENTTARGET: EX, __EVENTARGUMENT: '', __LASTFOCUS: '',
      __VIEWSTATE: vs, __VIEWSTATEGENERATOR: vsg, __VIEWSTATEENCRYPTED: '', __EVENTVALIDATION: ev,
      [SY]: year, [EX]: exam.exid,
    }),
  })
  html = r.body.toString('utf8')
  if (r.status !== 200) throw new Error(`exid postback ${year}: HTTP ${r.status}`)

  const idx = html.indexOf(year + '年試題')
  if (idx < 0) throw new Error(`${year}: 年試題 region not found (no data for this year?)`)
  const region = html.slice(idx, idx + 8000)

  const out = []
  for (const subj of SUBJECTS) {
    const sIdx = region.indexOf(subj.name)
    if (sIdx < 0) throw new Error(`${year}: subject "${subj.name}" not found in listing`)
    const after = region.slice(sIdx, sIdx + 1200)
    const links = [...after.matchAll(/ShowPicOut2\.aspx\?ASParam=[^"'&\s]+/gi)].map(m => m[0])
    if (links.length < 2) throw new Error(`${year} ${subj.name}: expected 2 PDF links, found ${links.length}`)
    out.push({ subject: subj, qPdf: BASE + links[0], aPdf: BASE + links[1], cookie })
  }
  return out
}

// ── PDF parsing ─────────────────────────────────────────────────────────
const FW_DIGITS = { '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9' }
const normDigits = s => s.replace(/[０-９]/g, c => FW_DIGITS[c])
const normLetter = c => c.replace(/[Ａ-Ｄ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))

function cleanLine(raw) {
  let s = raw.replace(/[▽△]/g, '').replace(/ /g, ' ').trim()
  if (!s) return ''
  if (/^第?\s*\d{1,3}\s*頁?$/.test(s)) return '' // bare page numbers
  return s
}

function parseOptions(text) {
  const opts = {}
  const re = /[(（]([A-DＡ-Ｄ])[)）]\s*([\s\S]*?)(?=[(（][A-DＡ-Ｄ][)）]|$)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const letter = normLetter(m[1])
    opts[letter] = (opts[letter] ? opts[letter] + ' ' : '') + m[2].replace(/\s+/g, ' ').trim()
  }
  return opts
}
function mergeOptions(existing, incoming) {
  const merged = { ...existing }
  for (const [k, v] of Object.entries(incoming)) {
    merged[k] = existing[k] ? (existing[k] + ' ' + v).trim() : v
  }
  return merged
}
function lastLetterIn(line) {
  const all = [...line.matchAll(/[(（]([A-DＡ-Ｄ])[)）]/g)]
  return all.length ? normLetter(all[all.length - 1][1]) : null
}

// Parse one subject's 考題 PDF text → array of { number, question, hasPassage }.
function parseQuestions(text, subjectName) {
  const startMatch = text.match(/選擇題\s*[（(]\s*占/)
  if (!startMatch) throw new Error(`${subjectName}: 選擇題 section header not found`)
  let region = text.slice(startMatch.index)
  const endMatch = region.slice(20).match(/(非選擇題|綜合題|寫作)\s*[（(]\s*占/)
  if (endMatch) region = region.slice(0, endMatch.index + 20)

  const lines = region.split('\n').map(cleanLine).filter(Boolean)

  const questions = []
  let cur = null
  let expect = 1
  let passage = null
  let passageBuf = null
  let mode = 'idle'

  const finishPassage = () => {
    if (passageBuf) {
      passage = { from: passageBuf.from, to: passageBuf.to, text: passageBuf.lines.join('').replace(/\s+/g, '') }
      passageBuf = null
    }
  }

  for (const line of lines) {
    const pm = normDigits(line).match(/閱讀.{0,12}回答\s*(\d{1,2})\s*[-－~～至到]\s*(\d{1,2})\s*題/)
    if (pm) {
      finishPassage()
      passageBuf = { from: +pm[1], to: +pm[2], lines: [] }
      mode = 'passage'
      continue
    }

    const qm = normDigits(line).match(/^(\d{1,2})\s*[.．、]\s*([\s\S]*)$/)
    if (qm && +qm[1] === expect && expect <= 60) {
      if (cur) questions.push(cur)
      finishPassage()
      const num = +qm[1]
      cur = { number: num, stemParts: [], options: {}, passage: null }
      if (passage && num >= passage.from && num <= passage.to) cur.passage = passage.text
      const rest = qm[2].trim()
      if (rest) cur.stemParts.push(rest)
      expect++
      mode = 'stem'
      continue
    }

    if (mode === 'passage') { passageBuf.lines.push(line); continue }
    if (!cur) continue

    if (/[(（][A-DＡ-Ｄ][)）]/.test(line)) {
      Object.assign(cur.options, mergeOptions(cur.options, parseOptions(line)))
      cur._lastOpt = lastLetterIn(line)
      mode = 'options'
      continue
    }
    if (mode === 'options' && cur._lastOpt) {
      cur.options[cur._lastOpt] = (cur.options[cur._lastOpt] + ' ' + line).trim()
    } else {
      cur.stemParts.push(line)
    }
  }
  if (cur) questions.push(cur)

  return questions.map(q => {
    const stem = q.stemParts.join('').replace(/\s+/g, '')
    const question = q.passage ? `〈閱讀測驗〉\n${q.passage}\n\n${stem}` : stem
    return { number: q.number, question, options: q.options, hasPassage: !!q.passage }
  })
}

// Parse the 參考答案 PDF text → one entry per question, each an array of
// answer letters. A cell with >1 letter (e.g.「B、D」) is a 送分 question
// where multiple options are accepted. Handles both answer-grid formats:
// space-separated (「A A C C…」) and concatenated (「CBBACBDBDA」).
function parseAnswers(text) {
  const cells = []
  // Each 答案 block runs from「答案」to the next「題號」(or end of text).
  // The title「選擇題參考答案」also matches but its block holds no A-D letters.
  const re = /答案\s*([\s\S]*?)(?=題號|$)/g
  let m
  while ((m = re.exec(text)) !== null) {
    // Collapse separators so「B 、 D」joins into one「B、D」cell; bare adjacent
    // letters then read as individual single-answer cells.
    const block = m[1].replace(/\s*[、,，或/]\s*/g, '、')
    for (const cellStr of block.match(/[A-DＡ-Ｄ](?:、[A-DＡ-Ｄ])*/g) || []) {
      cells.push((cellStr.match(/[A-DＡ-Ｄ]/g) || []).map(normLetter))
    }
  }
  return cells
}

// ── Scrape one exam ─────────────────────────────────────────────────────
async function scrapeExam(examId, exam, years, dryRun) {
  const allQuestions = []
  const report = []

  for (const year of years) {
    let listing
    try {
      listing = await fetchListing(year, exam)
    } catch (e) {
      console.error(`✗ ${examId} ${year}: ${e.message}`)
      report.push({ exam: examId, year, error: e.message })
      continue
    }
    if (dryRun) {
      console.log(`✓ ${examId} ${year}: listing OK — ${listing.length} subjects`)
      continue
    }

    for (const item of listing) {
      const { subject } = item
      try {
        const qRes = await request('GET', item.qPdf, { headers: { Cookie: item.cookie, Referer: PAGE } })
        const aRes = await request('GET', item.aPdf, { headers: { Cookie: item.cookie, Referer: PAGE } })
        if (qRes.status !== 200 || aRes.status !== 200) {
          throw new Error(`PDF HTTP q=${qRes.status} a=${aRes.status}`)
        }
        const qText = (await pdfParse(qRes.body)).text
        const aText = (await pdfParse(aRes.body)).text

        // Identity guard: subject name must match. 國語文 is a 全類科 shared
        // paper whose 類科 label varies year to year, so skip the label check
        // for it; other subjects must carry this exam's 類科 label.
        if (!qText.includes(subject.name)) {
          throw new Error(`PDF identity mismatch — subject "${subject.name}" absent`)
        }
        if (!subject.passages && !qText.includes(exam.classLabel)) {
          throw new Error(`PDF identity mismatch — 類科 "${exam.classLabel}" absent for ${subject.name}`)
        }

        const parsed = parseQuestions(qText, subject.name)
        const answers = parseAnswers(aText)
        if (parsed.length !== 25) {
          console.warn(`  ⚠ ${examId} ${year} ${subject.name}: parsed ${parsed.length} questions (expected 25)`)
        }
        if (answers.length !== parsed.length) {
          console.warn(`  ⚠ ${examId} ${year} ${subject.name}: ${answers.length} answers vs ${parsed.length} questions`)
        }

        let ok = 0
        for (const q of parsed) {
          const opts = q.options
          const filled = ['A', 'B', 'C', 'D'].filter(k => opts[k] && opts[k].length > 0)
          const complete = filled.length === 4
          const imageOptions = filled.length === 0
          const ansCell = answers[q.number - 1] || []
          const answer = ansCell[0] || ''
          const disputed = ansCell.length > 1 // 送分題：官方接受多個答案
          const rec = {
            id: `${year}T${subject.code}_${q.number}`,
            roc_year: year,
            session: '第一次',
            exam_code: `${year}教檢`,
            subject: subject.name,
            subject_tag: subject.id,
            subject_name: subject.name,
            stage_id: 0,
            number: q.number,
            question: q.question,
            options: { A: opts.A || '', B: opts.B || '', C: opts.C || '', D: opts.D || '' },
            answer,
            explanation: '',
          }
          if (disputed) rec.disputed = true
          if (!complete || !answer) {
            rec.incomplete = imageOptions ? 'image_options' : (!complete ? 'options' : 'answer')
            console.warn(`  ⚠ ${examId} ${year} ${subject.name} Q${q.number}: incomplete (${rec.incomplete})`)
          } else {
            ok++
          }
          allQuestions.push(rec)
        }
        console.log(`✓ ${examId} ${year} ${subject.name}: ${ok}/${parsed.length} complete`)
        report.push({ exam: examId, year, subject: subject.name, parsed: parsed.length, ok })
      } catch (e) {
        console.error(`✗ ${examId} ${year} ${subject.name}: ${e.message}`)
        report.push({ exam: examId, year, subject: subject.name, error: e.message })
      }
      await sleep(400)
    }
  }

  if (dryRun) return report

  allQuestions.sort((a, b) =>
    a.roc_year.localeCompare(b.roc_year) ||
    SUBJECTS.findIndex(s => s.id === a.subject_tag) - SUBJECTS.findIndex(s => s.id === b.subject_tag) ||
    a.number - b.number)

  const outPath = path.join(__dirname, '..', `questions-${examId}.json`)
  fs.writeFileSync(outPath, JSON.stringify({
    metadata: { category: '教師資格考試', exam: examId, generated: new Date().toISOString() },
    questions: allQuestions,
  }, null, 2))
  console.log(`📦 ${examId}: wrote ${allQuestions.length} questions → ${outPath}\n`)
  return report
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const yearArg = args.includes('--year') ? args[args.indexOf('--year') + 1] : null
  const years = yearArg && /^\d{3}$/.test(yearArg) ? [yearArg] : YEARS
  const examArg = args.includes('--exam') ? args[args.indexOf('--exam') + 1] : null
  const examIds = examArg ? [examArg] : Object.keys(EXAMS)

  const report = []
  for (const examId of examIds) {
    const exam = EXAMS[examId]
    if (!exam) { console.error(`unknown exam: ${examId}`); continue }
    const r = await scrapeExam(examId, exam, years, dryRun)
    report.push(...r)
  }
  console.table(report)
}

main().catch(e => { console.error(e); process.exit(1) })
