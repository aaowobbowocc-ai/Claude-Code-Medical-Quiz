#!/usr/bin/env node
// One-shot: recover the 16 questions that the main scraper skipped.
// PDFs are still online — the issue was parseQuestions had a `num <= 99` cap
// that dropped #100, plus some pages with odd layouts lost a few more.

const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

const TARGETS = [
  // doctor1 110-2
  { exam: 'doctor1', file: 'questions.json', code: '110101', c: '301', year: '110', session: '第二次',
    papers: [
      { s: '11', paperIdx: 1, subject: '醫學(一)', subject_tag: 'anatomy',  subject_name: '醫學(一)' },
      { s: '22', paperIdx: 2, subject: '醫學(二)', subject_tag: 'pathology', subject_name: '醫學(二)' },
    ] },
  // doctor2 112-2
  { exam: 'doctor2', file: 'questions-doctor2.json', code: '112080', c: '302', year: '112', session: '第二次',
    papers: [
      { s: '11', paperIdx: 3, subject: '醫學(三)', subject_tag: 'internal_medicine', subject_name: '醫學(三)' },
    ] },
  // medlab 113-1
  { exam: 'medlab', file: 'questions-medlab.json', code: '113020', c: '308', year: '113', session: '第一次',
    papers: [
      { s: '11', subject: '臨床生理學與病理學',         subject_tag: 'clinical_physio_path', subject_name: '臨床生理學與病理學' },
      { s: '44', subject: '微生物學與臨床微生物學',     subject_tag: 'microbiology',         subject_name: '微生物學與臨床微生物學' },
      { s: '66', subject: '臨床血清免疫學與臨床病毒學', subject_tag: 'serology',             subject_name: '臨床血清免疫學與臨床病毒學' },
    ] },
  // medlab 113-2
  { exam: 'medlab', file: 'questions-medlab.json', code: '113090', c: '308', year: '113', session: '第二次',
    papers: [
      { s: '22', subject: '臨床血液學與血庫學',         subject_tag: 'hematology', subject_name: '臨床血液學與血庫學' },
      { s: '33', subject: '醫學分子檢驗學與臨床鏡檢學', subject_tag: 'molecular',  subject_name: '醫學分子檢驗學與臨床鏡檢學' },
      { s: '44', subject: '微生物學與臨床微生物學',     subject_tag: 'microbiology', subject_name: '微生物學與臨床微生物學' },
      { s: '66', subject: '臨床血清免疫學與臨床病毒學', subject_tag: 'serology',   subject_name: '臨床血清免疫學與臨床病毒學' },
    ] },
  // ot 113-2
  { exam: 'ot', file: 'questions-ot.json', code: '113090', c: '312', year: '113', session: '第二次',
    papers: [
      { s: '44', subject: '心理疾病職能治療學', subject_tag: 'ot_mental', subject_name: '心理疾病職能治療學' },
    ] },
]

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 20000,
      headers: { 'User-Agent': UA, 'Accept': 'application/pdf,*/*', 'Referer': 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location
        if (!loc || !loc.startsWith('http')) { res.resume(); return reject(new Error('bad redirect')) }
        return fetchPdf(loc, retries).then(resolve, reject)
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
      const ct = res.headers['content-type'] || ''
      if (!ct.includes('pdf') && !ct.includes('octet')) { res.resume(); return reject(new Error('not PDF')) }
      const cs = []
      res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    })
    req.on('error', e => retries > 0 ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 1000) : reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

// Question parser — lifted from scrape-moex-old.js but with the `<= 99` cap
// raised to 120 (doctor1 110-2 has 100 questions per paper).
function parseQuestions(text) {
  const out = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let cur = null, opt = null, buf = ''
  const flushOpt = () => { if (cur && opt) cur.options[opt] = buf.trim(); buf = ''; opt = null }
  const flushQ = () => { flushOpt(); if (cur && cur.question && Object.keys(cur.options).length >= 2) out.push(cur); cur = null }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^(代\s*號|類\s*科|科\s*目|考試|頁次|等\s*別|全.*題|本試題|座號|※|【|】)/.test(line)) continue
    if (/^第?\s*\d+\s*頁/.test(line)) continue
    const qm = line.match(/^(\d{1,3})[.、．]\s*(.*)$/)
    if (qm) {
      const num = parseInt(qm[1])
      const rest = (qm[2] || '').trim()
      const looks = rest === '' || /[\u4e00-\u9fff a-zA-Z（(]/.test(rest)
      const isFirst = !cur && out.length === 0
      const isNext = cur && num === cur.number + 1
      if (looks && num >= 1 && num <= 120 && (isFirst || isNext)) {
        flushQ()
        cur = { number: num, question: rest, options: {} }
        continue
      }
    }
    // Option line must be: letter followed by period, OR letter alone on its line.
    // "B淋巴細胞…" (no period) is the question text, not option B.
    const om = line.match(/^[（(]?\s*([A-Da-dＡＢＣＤ])\s*[)）]?[.．]\s*(.*)$/)
             || (line.length <= 2 && line.match(/^([A-Da-dＡＢＣＤ])$/))
    if (om && cur) {
      const L = om[1].toUpperCase().replace('Ａ','A').replace('Ｂ','B').replace('Ｃ','C').replace('Ｄ','D')
      flushOpt(); opt = L; buf = om[2] || ''
      continue
    }
    if (opt) buf += ' ' + line
    else if (cur) cur.question += ' ' + line
  }
  flushQ()
  return out
}

function parseAnswers(text) {
  const ans = {}
  const fw = /答案\s*([ＡＢＣＤ#＃]+)/g
  let m, n = 1
  while ((m = fw.exec(text)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) ans[n++] = k
    }
  }
  if (Object.keys(ans).length >= 20) return ans
  const hw = /(\d{1,3})\s*[.、．:：]\s*([A-Da-d])/g
  while ((m = hw.exec(text)) !== null) {
    const num = parseInt(m[1])
    if (num >= 1 && num <= 120) ans[num] = m[2].toUpperCase()
  }
  return ans
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  // Key: exam_code|subject|number — so 113020 (113-1) and 113090 (113-2) stay distinct
  const MISSING = new Set([
    // doctor1 110-2
    '110101|醫學(一)|100', '110101|醫學(二)|100',
    // doctor2 112-2
    '112080|醫學(三)|46',
    // medlab 113-1 (code 113020)
    '113020|臨床生理學與病理學|57',
    '113020|微生物學與臨床微生物學|11', '113020|微生物學與臨床微生物學|12',
    '113020|臨床血清免疫學與臨床病毒學|3', '113020|臨床血清免疫學與臨床病毒學|27',
    // medlab 113-2 (code 113090)
    '113090|臨床血液學與血庫學|58',
    '113090|醫學分子檢驗學與臨床鏡檢學|37', '113090|醫學分子檢驗學與臨床鏡檢學|48',
    '113090|微生物學與臨床微生物學|10',
    '113090|臨床血清免疫學與臨床病毒學|5', '113090|臨床血清免疫學與臨床病毒學|66',
    // ot 113-2
    '113090|心理疾病職能治療學|11', '113090|心理疾病職能治療學|38',
  ])

  for (const t of TARGETS) {
    console.log(`\n=== ${t.exam} ${t.year}${t.session} (code=${t.code}) ===`)
    const filePath = path.join(__dirname, '..', t.file)
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const existing = raw.questions

    for (const p of t.papers) {
      const qUrl = `${BASE}?t=Q&code=${t.code}&c=${t.c}&s=${p.s}&q=1`
      const aUrl = `${BASE}?t=S&code=${t.code}&c=${t.c}&s=${p.s}&q=1`

      let parsed, answers = {}
      try {
        const qBuf = await fetchPdf(qUrl)
        parsed = parseQuestions((await pdfParse(qBuf)).text)
      } catch (e) { console.log(`  ✗ ${p.subject}: question PDF failed — ${e.message}`); continue }
      try {
        const aBuf = await fetchPdf(aUrl)
        answers = parseAnswers((await pdfParse(aBuf)).text)
      } catch (e) { console.log(`  ⚠ ${p.subject}: answer PDF failed — ${e.message}`) }

      console.log(`  ${p.subject} (s=${p.s}): parsed ${parsed.length}Q, ${Object.keys(answers).length}A`)

      // Insert only the ones we're missing
      for (const q of parsed) {
        const key = `${t.code}|${p.subject}|${q.number}`
        if (!MISSING.has(key)) continue
        const a = answers[q.number]
        if (!a) { console.log(`  ✗ ${key}: no answer`); continue }
        if (!q.question || Object.keys(q.options).length < 4) {
          console.log(`  ✗ ${key}: incomplete (opts=${Object.keys(q.options).length})`)
          continue
        }
        // Build the entry. doctor1 uses string id; others use numeric.
        const entry = {
          roc_year: t.year, session: t.session, exam_code: t.code,
          subject: p.subject, subject_tag: p.subject_tag, subject_name: p.subject_name,
          stage_id: 0, number: q.number, question: q.question.trim(),
          options: q.options, answer: a, explanation: '',
        }
        if (t.exam === 'doctor1' || t.exam === 'doctor2') {
          entry.id = `${t.code}_${p.paperIdx || parseInt(p.s.slice(0,1)) || 1}_${q.number}`
        } else {
          let maxId = 0
          for (const ex of existing) {
            const n = typeof ex.id === 'number' ? ex.id : parseInt(ex.id) || 0
            if (n > maxId) maxId = n
          }
          entry.id = maxId + 1
        }
        // Put into existing before writing (id uniqueness)
        existing.push(entry)
        console.log(`  ✅ recovered ${key}: ${q.question.slice(0, 40)}...`)
        MISSING.delete(key)
      }
      await sleep(400)
    }

    raw.total = existing.length
    raw.questions = existing
    fs.writeFileSync(filePath, JSON.stringify(raw, null, 2))
    console.log(`  written → ${t.file} (total ${existing.length})`)
  }

  // Report any still-missing
  console.log('\n=== leftovers ===')
  if (MISSING.size) console.log([...MISSING])
  else console.log('(none)')
}

main().catch(e => { console.error(e); process.exit(1) })
