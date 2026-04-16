#!/usr/bin/env node
// Scraper for 中醫師(一/二) + 獸醫師 — one-shot, not integrated into scrape-moex.js
// because these exams use unusual session-code suffixes (070/080/100) and
// the subject codes are 2-digit (s=11..66) rather than 4-digit.
//
// Usage:
//   node scripts/scrape-tcm-vet.js                 # all three
//   node scripts/scrape-tcm-vet.js --exam vet      # one of: vet | tcm1 | tcm2
//   node scripts/scrape-tcm-vet.js --dry-run

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

// ─── Exam definitions ───
// 114+ uses 4-digit s codes (s=0201, 1001 etc); 112-113 used 2-digit (s=11, 22).
// classCode is also per-session: 114+ uses 317/318/314 directly, while 110-111
// (中醫) used the older 101/102 codes alongside a different question-text layout.
// Each session here carries its own (classCode, subjects) override.

const VET_SUBJECTS_OLD = [
  { s: '11', name: '獸醫病理學',     tag: 'vet_pathology' },
  { s: '22', name: '獸醫藥理學',     tag: 'vet_pharmacology' },
  { s: '33', name: '獸醫實驗診斷學', tag: 'vet_lab_diagnosis' },
  { s: '44', name: '獸醫普通疾病學', tag: 'vet_common_disease' },
  { s: '55', name: '獸醫傳染病學',   tag: 'vet_infectious' },
  { s: '66', name: '獸醫公共衛生學', tag: 'vet_public_health' },
]
const VET_SUBJECTS_NEW = [
  { s: '1001', name: '獸醫病理學',     tag: 'vet_pathology' },
  { s: '1002', name: '獸醫藥理學',     tag: 'vet_pharmacology' },
  { s: '1003', name: '獸醫實驗診斷學', tag: 'vet_lab_diagnosis' },
  { s: '1004', name: '獸醫普通疾病學', tag: 'vet_common_disease' },
  { s: '1005', name: '獸醫傳染病學',   tag: 'vet_infectious' },
  { s: '1006', name: '獸醫公共衛生學', tag: 'vet_public_health' },
]

const TCM1_SUBJECTS_OLD = [
  { s: '11', name: '中醫基礎醫學(一)', tag: 'tcm_basic_1' },
  { s: '22', name: '中醫基礎醫學(二)', tag: 'tcm_basic_2' },
]
const TCM1_SUBJECTS_NEW = [
  { s: '0201', name: '中醫基礎醫學(一)', tag: 'tcm_basic_1' },
  { s: '0202', name: '中醫基礎醫學(二)', tag: 'tcm_basic_2' },
]

const TCM2_SUBJECTS_OLD = [
  { s: '11', name: '中醫臨床醫學(一)', tag: 'tcm_clinical_1' },
  { s: '22', name: '中醫臨床醫學(二)', tag: 'tcm_clinical_2' },
  { s: '33', name: '中醫臨床醫學(三)', tag: 'tcm_clinical_3' },
  { s: '44', name: '中醫臨床醫學(四)', tag: 'tcm_clinical_4' },
]
const TCM2_SUBJECTS_NEW = [
  { s: '0201', name: '中醫臨床醫學(一)', tag: 'tcm_clinical_1' },
  { s: '0202', name: '中醫臨床醫學(二)', tag: 'tcm_clinical_2' },
  { s: '0203', name: '中醫臨床醫學(三)', tag: 'tcm_clinical_3' },
  { s: '0204', name: '中醫臨床醫學(四)', tag: 'tcm_clinical_4' },
]

const EXAMS = {
  vet: {
    label: '獸醫師',
    file: 'questions-vet.json',
    sessions: [
      // 106-109: first=020/030, second=100 (108 uses 030 for first session)
      { year: '106', code: '106020', label: '第一次', classCode: '314', subjects: VET_SUBJECTS_OLD },
      { year: '106', code: '106100', label: '第二次', classCode: '314', subjects: VET_SUBJECTS_OLD },
      { year: '107', code: '107020', label: '第一次', classCode: '314', subjects: VET_SUBJECTS_OLD },
      { year: '107', code: '107100', label: '第二次', classCode: '314', subjects: VET_SUBJECTS_OLD },
      { year: '108', code: '108030', label: '第一次', classCode: '314', subjects: VET_SUBJECTS_OLD },
      { year: '108', code: '108100', label: '第二次', classCode: '314', subjects: VET_SUBJECTS_OLD },
      { year: '109', code: '109020', label: '第一次', classCode: '314', subjects: VET_SUBJECTS_OLD },
      { year: '109', code: '109100', label: '第二次', classCode: '314', subjects: VET_SUBJECTS_OLD },
      { year: '110', code: '110100', label: '第二次', classCode: '314', subjects: VET_SUBJECTS_OLD },
      { year: '111', code: '111100', label: '第二次', classCode: '314', subjects: VET_SUBJECTS_OLD },
      { year: '112', code: '112100', label: '第二次', classCode: '314', subjects: VET_SUBJECTS_OLD },
      { year: '113', code: '113090', label: '第二次', classCode: '314', subjects: VET_SUBJECTS_OLD },
      { year: '114', code: '114090', label: '第二次', classCode: '314', subjects: VET_SUBJECTS_NEW },
    ],
  },
  tcm1: {
    label: '中醫師(一)',
    file: 'questions-tcm1.json',
    sessions: [
      { year: '112', code: '112020', label: '第一次', classCode: '317', subjects: TCM1_SUBJECTS_OLD },
      { year: '112', code: '112100', label: '第二次', classCode: '317', subjects: TCM1_SUBJECTS_OLD },
      { year: '113', code: '113020', label: '第一次', classCode: '317', subjects: TCM1_SUBJECTS_OLD },
      { year: '113', code: '113090', label: '第二次', classCode: '317', subjects: TCM1_SUBJECTS_OLD },
      { year: '114', code: '114090', label: '第二次', classCode: '317', subjects: TCM1_SUBJECTS_NEW },
    ],
  },
  tcm2: {
    label: '中醫師(二)',
    file: 'questions-tcm2.json',
    sessions: [
      { year: '112', code: '112020', label: '第一次', classCode: '318', subjects: TCM2_SUBJECTS_OLD },
      { year: '112', code: '112080', label: '第二次', classCode: '318', subjects: TCM2_SUBJECTS_OLD },
      { year: '113', code: '113020', label: '第一次', classCode: '318', subjects: TCM2_SUBJECTS_OLD },
      { year: '113', code: '113070', label: '第二次', classCode: '318', subjects: TCM2_SUBJECTS_OLD },
      { year: '114', code: '114070', label: '第二次', classCode: '318', subjects: TCM2_SUBJECTS_NEW },
    ],
  },
}

// ─── HTTP ───

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 20000,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/pdf,*/*',
        'Referer': 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx',
      },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location
        if (!loc || !loc.startsWith('http')) {
          res.resume()
          return reject(new Error(`bad redirect to ${loc}`))
        }
        return fetchPdf(loc, retries).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 1000)
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      const ct = res.headers['content-type'] || ''
      if (!ct.includes('pdf') && !ct.includes('octet')) {
        res.resume()
        return reject(new Error(`not PDF: ${ct}`))
      }
      const cs = []
      res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    })
    req.on('error', e => retries > 0
      ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 1000)
      : reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

// ─── Parsing (lifted from recover-missing-16.js — the fixed version) ───

function parseQuestions(text) {
  const out = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let cur = null, opt = null, buf = ''
  const flushOpt = () => { if (cur && opt) cur.options[opt] = buf.trim(); buf = ''; opt = null }
  const flushQ = () => {
    flushOpt()
    if (cur && cur.question && Object.keys(cur.options).length >= 2) out.push(cur)
    cur = null
  }
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
    // Option: letter + required period separator (avoids "B淋巴細胞..." false match)
    const om = line.match(/^[（(]?\s*([A-Da-dＡＢＣＤ])\s*[)）]?[.．]\s*(.*)$/)
             || (line.length <= 2 && line.match(/^([A-Da-dＡＢＣＤ])$/))
    if (om && cur) {
      const L = om[1].toUpperCase()
        .replace('Ａ','A').replace('Ｂ','B').replace('Ｃ','C').replace('Ｄ','D')
      flushOpt()
      opt = L
      buf = om[2] || ''
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

function parseCorrections(text) {
  const corrections = {}
  const lines = text.split(/\n/)
  for (const line of lines) {
    const giveM = line.match(/第?\s*(\d{1,3})\s*題.*(?:一律給分|送分)/i)
    if (giveM) { corrections[parseInt(giveM[1])] = '*'; continue }
    const changeM = line.match(/第?\s*(\d{1,3})\s*題.*更正.*([A-D])/i)
    if (changeM) { corrections[parseInt(changeM[1])] = changeM[2]; continue }
  }
  return corrections
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── Main ───

async function scrapeExam(key, dryRun) {
  const def = EXAMS[key]
  console.log(`\n${'='.repeat(60)}\n  ${def.label} (${key})\n${'='.repeat(60)}`)

  const all = []
  let nextId = 1

  for (const sess of def.sessions) {
    console.log(`\n--- ${sess.year}年${sess.label} (${sess.code}, c=${sess.classCode}) ---`)

    for (const sub of sess.subjects) {
      const qUrl = `${BASE}?t=Q&code=${sess.code}&c=${sess.classCode}&s=${sub.s}&q=1`
      const aUrl = `${BASE}?t=S&code=${sess.code}&c=${sess.classCode}&s=${sub.s}&q=1`
      const mUrl = `${BASE}?t=M&code=${sess.code}&c=${sess.classCode}&s=${sub.s}&q=1`

      if (dryRun) {
        console.log(`  Q ${qUrl}`)
        continue
      }

      let qText, answers = {}, corrections = {}
      try {
        qText = (await pdfParse(await fetchPdf(qUrl))).text
      } catch (e) {
        console.log(`  ✗ ${sub.name}: Q PDF — ${e.message}`)
        continue
      }
      try {
        answers = parseAnswers((await pdfParse(await fetchPdf(aUrl))).text)
      } catch (e) {
        console.log(`  ⚠ ${sub.name}: A PDF — ${e.message}`)
      }
      try {
        corrections = parseCorrections((await pdfParse(await fetchPdf(mUrl))).text)
        if (Object.keys(corrections).length) {
          console.log(`  📝 ${sub.name}: ${Object.keys(corrections).length} corrections`)
        }
      } catch { /* normal */ }

      for (const [num, ans] of Object.entries(corrections)) {
        if (ans !== '*') answers[num] = ans
      }

      const parsed = parseQuestions(qText)
      console.log(`  ✓ ${sub.name}: ${parsed.length}Q, ${Object.keys(answers).length}A`)

      for (const q of parsed) {
        const a = answers[q.number]
        if (!a) continue
        if (!q.question || Object.keys(q.options).length < 4) continue
        all.push({
          id: nextId++,
          roc_year: sess.year,
          session: sess.label,
          exam_code: sess.code,
          subject: sub.name,
          subject_tag: sub.tag,
          subject_name: sub.name,
          stage_id: 0,
          number: q.number,
          question: q.question.trim(),
          options: q.options,
          answer: a,
          explanation: '',
          ...(corrections[q.number] === '*' ? { disputed: true } : {}),
        })
      }
      await sleep(300)
    }
    await sleep(400)
  }

  if (dryRun) return 0

  const outFile = path.join(__dirname, '..', def.file)
  const out = {
    metadata: {
      exam: key, label: def.label,
      scraped_at: new Date().toISOString(),
      source: 'wwwq.moex.gov.tw',
    },
    total: all.length,
    questions: all,
  }
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf-8')
  console.log(`\n✅ Wrote ${all.length} questions to ${outFile}`)
  return all.length
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const examIdx = args.indexOf('--exam')
  const only = examIdx >= 0 ? args[examIdx + 1] : null

  const keys = only ? [only] : Object.keys(EXAMS)
  for (const k of keys) {
    if (!EXAMS[k]) { console.error(`Unknown exam: ${k}`); continue }
    await scrapeExam(k, dryRun)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
