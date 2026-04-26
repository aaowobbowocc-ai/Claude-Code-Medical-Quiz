#!/usr/bin/env node
// One-shot: fill two known gaps
//   1. nutrition 112 第二次 (code=112110, c=102)
//   2. radiology 110-113 第一次 (codes 110020/111020/112020/113020, c=309, s=2-digit)
//      + radiology 113 第二次 (code=113090, c=309, s=2-digit)
//
// Merges into existing questions-nutrition.json / questions-radiology.json
// without overwriting other years. Safe to re-run (idempotent by exam_code+number).

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { fetchPdf, cachedFetch, buildMoexUrl } = require('./lib/pdf-fetcher')
const https = require('https')
const pdfParse = require('pdf-parse')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'


function parseQuestionsPdf(text) {
  // Pre-normalize: some MoEX PDFs put "1." / "A." on their own lines, with the
  // question/option text on the following line. Merge them before parsing.
  //   "1.\n題目...\nA.\n選項..."  →  "1. 題目...\nA. 選項..."
  const rawLines = text.replace(/\r\n/g, '\n').split('\n')
  const lines = []
  for (let i = 0; i < rawLines.length; i++) {
    const L = rawLines[i]
    const t = L.trim()
    if (/^(\d{1,3})[.、．]$/.test(t) || /^([A-Da-dＡＢＣＤ])[.．、]$/.test(t)) {
      // Find next non-empty line and merge
      let j = i + 1
      while (j < rawLines.length && !rawLines[j].trim()) j++
      if (j < rawLines.length) {
        lines.push(t + ' ' + rawLines[j].trim())
        i = j
        continue
      }
    }
    lines.push(L)
  }

  const questions = []
  let cur = null, opt = null, buf = ''
  let inMc = false
  const flushOpt = () => { if (cur && opt) cur.options[opt] = buf.trim(); buf = ''; opt = null }
  const flushQ = () => {
    flushOpt()
    if (cur && cur.question && Object.keys(cur.options).length >= 2) questions.push(cur)
    cur = null
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^(代\s*號|類\s*科|科\s*目|考試|頁次|等\s*別|全.*題|本試題|座號|※)/.test(line)) continue
    if (/^第?\s*\d+\s*頁/.test(line)) continue
    if (/測驗題|單一選擇題|選擇題/.test(line) && !inMc) {
      cur = null; opt = null; buf = ''; inMc = true; continue
    }
    const qm = line.match(/^(\d{1,3})[.、．]\s*(.*)$/)
    if (qm) {
      const num = parseInt(qm[1])
      const isFirst = !cur && questions.length === 0
      // Sequential numbering is the strong signal; trust it even if rest is
      // short/numeric (e.g. "2. 235" for a physics question about U-235).
      if (num >= 1 && num <= 120 && (isFirst || (cur && num === cur.number + 1))) {
        flushQ()
        cur = { number: num, question: (qm[2] || '').trim(), options: {} }
        continue
      }
    }
    const om = line.match(/^[(（]\s*([A-Da-dＡＢＣＤ])\s*[)）]\s*(.*)$/)
            || line.match(/^([A-Da-dＡＢＣＤ])\s*[.．、]\s*(.*)$/)
    if (om && cur) {
      flushOpt()
      opt = om[1].toUpperCase().replace('Ａ','A').replace('Ｂ','B').replace('Ｃ','C').replace('Ｄ','D')
      buf = om[2] || ''
      continue
    }
    if (opt) buf += ' ' + line
    else if (cur) cur.question += ' ' + line
  }
  flushQ()
  return questions
}

function parseAnswersPdf(text) {
  const answers = {}
  const fw = /答案\s*([ＡＢＣＤ]+)/g
  let m, n = 1
  while ((m = fw.exec(text)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) answers[n++] = k
    }
  }
  if (Object.keys(answers).length >= 20) return answers
  const hw = /(\d{1,2})\s*[.\s、．:：]\s*([A-Da-d])/g
  let hm
  while ((hm = hw.exec(text)) !== null) {
    const num = parseInt(hm[1])
    if (num >= 1 && num <= 80) answers[num] = hm[2].toUpperCase()
  }
  return answers
}

const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchAndParse(code, c, s, label) {
  const qUrl = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
  const aUrl = `${BASE}?t=S&code=${code}&c=${c}&s=${s}&q=1`
  let qText, aText
  try {
    const qBuf = await fetchPdf(qUrl)
    qText = (await pdfParse(qBuf)).text
  } catch (e) {
    console.log(`  ✗ ${label}: ${e.message}`)
    return null
  }
  try {
    const aBuf = await fetchPdf(aUrl)
    aText = (await pdfParse(aBuf)).text
  } catch (e) {
    console.log(`  ⚠ ${label} no answers: ${e.message}`)
    aText = ''
  }
  const parsed = parseQuestionsPdf(qText)
  const answers = parseAnswersPdf(aText)
  console.log(`  ✓ ${label}: ${parsed.length} Q / ${Object.keys(answers).length} A`)
  return { parsed, answers }
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'))
}
function atomicWrite(p, obj) {
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, p)
}

// ─── nutrition 112 第二次 ───
async function scrapeNutrition112_2() {
  console.log('\n=== nutrition 112 第二次 (code=112110, c=101) ===')
  // 112-2 合辦梯次：營養師的 class code 是 101（與護理師的 c=102 調換）
  const SUBJECTS = [
    { s: '0101', name: '生理學與生物化學', tag: 'physio_biochem' },
    { s: '0102', name: '營養學', tag: 'nutrition_science' },
    { s: '0103', name: '膳食療養學', tag: 'diet_therapy' },
    { s: '0104', name: '團體膳食設計與管理', tag: 'group_meal' },
    { s: '0105', name: '公共衛生營養學', tag: 'public_nutrition' },
    { s: '0106', name: '食品衛生與安全', tag: 'food_safety' },
  ]
  const code = '112110', c = '101', year = '112', session = '第二次'
  const file = path.join(__dirname, '..', 'questions-nutrition.json')
  const data = loadJson(file)
  const existingKey = new Set(data.questions.map(q => `${q.exam_code}_${q.number}_${q.subject_tag}`))
  let nextId = Math.max(...data.questions.map(q => q.id || 0)) + 1
  const added = []
  for (const sub of SUBJECTS) {
    const res = await fetchAndParse(code, c, sub.s, `${sub.name} ${code}`)
    if (!res) continue
    for (const q of res.parsed) {
      const ans = res.answers[q.number]
      if (!ans) continue
      const key = `${code}_${q.number}_${sub.tag}`
      if (existingKey.has(key)) continue
      const cleanOpts = {}
      for (const k of ['A', 'B', 'C', 'D']) cleanOpts[k] = stripPUA(q.options[k] || '')
      added.push({
        id: nextId++, roc_year: year, session, exam_code: code,
        subject: sub.name, subject_tag: sub.tag, subject_name: sub.name,
        stage_id: 0, number: q.number,
        question: stripPUA(q.question), options: cleanOpts,
        answer: ans, explanation: '',
      })
    }
    await sleep(400)
  }
  if (added.length === 0) { console.log('  (nothing to add)'); return 0 }
  data.questions.push(...added)
  data.total = data.questions.length
  atomicWrite(file, data)
  console.log(`  ✅ +${added.length} questions → ${data.questions.length} total`)
  return added.length
}

// ─── radiology 110-113 ───
async function scrapeRadiologyOld() {
  console.log('\n=== radiology 110-113 第一次 + 113 第二次 (c=309, s=2-digit) ===')
  // Old-year subject codes are 2-digit (s=11..16 for 6 papers)
  const SUBJECTS = [
    { s: '11', name: '基礎醫學（包括解剖學、生理學與病理學）', tag: 'basic_medicine' },
    { s: '22', name: '醫學物理學與輻射安全', tag: 'med_physics' },
    { s: '33', name: '放射線器材學（包括磁振學與超音波學）', tag: 'radio_instruments' },
    { s: '44', name: '放射線診斷原理與技術學', tag: 'radio_diagnosis' },
    { s: '55', name: '放射線治療原理與技術學', tag: 'radio_therapy' },
    { s: '66', name: '核子醫學診療原理與技術學', tag: 'nuclear_medicine' },
  ]
  const SESSIONS = [
    { year: '110', code: '110020', session: '第一次' },
    { year: '110', code: '110100', session: '第二次' },
    { year: '111', code: '111020', session: '第一次' },
    { year: '111', code: '111100', session: '第二次' },
    { year: '112', code: '112020', session: '第一次' },
    { year: '112', code: '112100', session: '第二次' },
    { year: '113', code: '113020', session: '第一次' },
    { year: '113', code: '113090', session: '第二次' },
  ]
  const c = '309'
  const file = path.join(__dirname, '..', 'questions-radiology.json')
  const data = loadJson(file)
  const existingKey = new Set(data.questions.map(q => `${q.exam_code}_${q.number}_${q.subject_tag}`))
  let nextId = Math.max(...data.questions.map(q => q.id || 0)) + 1
  const added = []
  for (const sess of SESSIONS) {
    console.log(`\n  --- ${sess.year} ${sess.session} (${sess.code}) ---`)
    for (const sub of SUBJECTS) {
      const res = await fetchAndParse(sess.code, c, sub.s, `${sub.name}`)
      if (!res) continue
      for (const q of res.parsed) {
        const ans = res.answers[q.number]
        if (!ans) continue
        const key = `${sess.code}_${q.number}_${sub.tag}`
        if (existingKey.has(key)) continue
        const cleanOpts = {}
        for (const k of ['A', 'B', 'C', 'D']) cleanOpts[k] = stripPUA(q.options[k] || '')
        added.push({
          id: nextId++, roc_year: sess.year, session: sess.session, exam_code: sess.code,
          subject: sub.name, subject_tag: sub.tag, subject_name: sub.name,
          stage_id: 0, number: q.number,
          question: stripPUA(q.question), options: cleanOpts,
          answer: ans, explanation: '',
        })
      }
      await sleep(400)
    }
    await sleep(500)
  }
  if (added.length === 0) { console.log('  (nothing to add)'); return 0 }
  data.questions.push(...added)
  data.total = data.questions.length
  atomicWrite(file, data)
  console.log(`\n  ✅ +${added.length} questions → ${data.questions.length} total`)
  return added.length
}

async function main() {
  const args = process.argv.slice(2)
  const runNutrition = args.includes('--nutrition') || args.includes('--all')
  const runRadiology = args.includes('--radiology') || args.includes('--all')
  if (!runNutrition && !runRadiology) {
    console.log('Usage: node scrape-fill-gaps-2026-04-16.js [--nutrition|--radiology|--all]')
    process.exit(1)
  }
  let total = 0
  if (runNutrition) total += await scrapeNutrition112_2()
  if (runRadiology) total += await scrapeRadiologyOld()
  console.log(`\n🎉 total new questions: ${total}`)
}
main().catch(e => { console.error(e); process.exit(1) })
