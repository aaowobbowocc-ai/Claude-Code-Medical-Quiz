#!/usr/bin/env node
// Backfill/overwrite the 9 missing-browser-search PDFs that *do* return content.
// Source list: backend/MISSING-BROWSER-SEARCH.md (✅ 有 PDF section).
//
// Strategy per target:
//   1. Download t=Q and t=S PDFs
//   2. Try standard text parser; if fewer than 60 questions parsed, fall back
//      to mupdf column-aware parser (for 100-105 era formatting).
//   3. For each listed missing Qnum: overwrite if existing is truncated,
//      add if absent.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

let parseColumnAware = null
try { parseColumnAware = require('./lib/moex-column-parser')
const { fetchPdf, cachedFetch, buildMoexUrl } = require('./lib/pdf-fetcher').parseColumnAware } catch {}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

const TARGETS = [
  { exam: 'nursing', code: '108020', c: '101', s: '0101', subject: '基礎醫學',
    tag: 'basic_medicine', year: '108', session: '第一次', nums: [60,61,66,72] },
  { exam: 'nursing', code: '101030', c: '105', s: '0402', subject: '內外科護理學',
    tag: 'med_surg', year: '101', session: '第一次', nums: [66] },
  { exam: 'nursing', code: '105030', c: '106', s: '0502', subject: '基本護理學與護理行政',
    tag: 'basic_nursing', year: '105', session: '第一次', nums: [18] },
  { exam: 'nursing', code: '100030', c: '105', s: '0403', subject: '產兒科護理學',
    tag: 'obs_ped', year: '100', session: '第一次', nums: [15] },
  { exam: 'nursing', code: '102030', c: '107', s: '0404', subject: '精神科與社區衛生護理學',
    tag: 'psych_community', year: '102', session: '第一次',
    nums: Array.from({length:40},(_,i)=>41+i) },
  { exam: 'nursing', code: '100140', c: '105', s: '0108', subject: '基礎醫學',
    tag: 'basic_medicine', year: '100', session: '第二次', nums: [42] },
  { exam: 'tcm1', code: '100030', c: '107', s: '0602', subject: '中醫基礎醫學(二)',
    tag: 'tcm_basic_2', year: '100', session: '第一次', nums: [17] },
  { exam: 'tcm2', code: '108110', c: '102', s: '0103', subject: '中醫臨床醫學(一)',
    tag: 'tcm_clinical_1', year: '108', session: '第二次', nums: [33] },
  { exam: 'customs', code: '110050', c: '101', s: '0308', subject: '法學知識',
    tag: 'law_knowledge', year: '110', session: '關務特考', nums: [8,31,34,36,40] },
]


function parseQuestionsPdfText(text) {
  const rawLines = text.replace(/\r\n/g, '\n').split('\n')
  const lines = []
  for (let i = 0; i < rawLines.length; i++) {
    const L = rawLines[i]
    const t = L.trim()
    if (/^(\d{1,3})[.、．]$/.test(t) || /^([A-Da-dＡＢＣＤ])[.．、]$/.test(t)) {
      let j = i + 1
      while (j < rawLines.length && !rawLines[j].trim()) j++
      if (j < rawLines.length) { lines.push(t + ' ' + rawLines[j].trim()); i = j; continue }
    }
    lines.push(L)
  }
  const questions = []
  let cur = null, opt = null, buf = '', inMc = false
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
    if (/測驗題|單一選擇題|選擇題/.test(line) && !inMc) { cur = null; opt = null; buf = ''; inMc = true; continue }
    const qm = line.match(/^(\d{1,3})[.、．]\s*(.*)$/)
    if (qm) {
      const num = parseInt(qm[1])
      const isFirst = !cur && questions.length === 0
      if (num >= 1 && num <= 120 && (isFirst || (cur && num === cur.number + 1))) {
        flushQ(); cur = { number: num, question: (qm[2] || '').trim(), options: {} }; continue
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
  const hw = /答案\s*([A-Da-d]+)/g
  let hm; n = 1
  while ((hm = hw.exec(text)) !== null) {
    for (const ch of hm[1]) answers[n++] = ch.toUpperCase()
  }
  return answers
}

const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function processTarget(t, dryRun) {
  const qUrl = `${BASE}?t=Q&code=${t.code}&c=${t.c}&s=${t.s}&q=1`
  const aUrl = `${BASE}?t=S&code=${t.code}&c=${t.c}&s=${t.s}&q=1`
  console.log(`\n── ${t.exam} ${t.code} ${t.subject} (want ${t.nums.length} q) ──`)
  let qBuf, aBuf
  try { qBuf = await fetchPdf(qUrl) } catch (e) { console.log('  ✗ Q fetch:', e.message); return null }
  try { aBuf = await fetchPdf(aUrl) } catch (e) { console.log('  ⚠ A fetch:', e.message); aBuf = null }
  const qText = (await pdfParse(qBuf)).text
  const aText = aBuf ? (await pdfParse(aBuf)).text : ''
  let parsed = parseQuestionsPdfText(qText)
  if (parsed.length < 40 && parseColumnAware) {
    console.log(`  ⚠ standard parser got ${parsed.length}, trying column-aware`)
    try {
      const alt = await parseColumnAware(qBuf)
      if (alt && alt.length > parsed.length) parsed = alt
    } catch (e) { console.log('  ✗ column parser failed:', e.message) }
  }
  const answers = parseAnswersPdf(aText)
  console.log(`  parsed: ${parsed.length} Q / ${Object.keys(answers).length} A`)
  const byNum = new Map(parsed.map(q => [q.number, q]))
  const out = []
  for (const n of t.nums) {
    const p = byNum.get(n)
    if (!p) { console.log(`  ✗ Q${n}: not in parsed`); continue }
    const a = answers[n]
    const aOk = a && /^[A-D]$/.test(a)
    const qOk = p.question && p.question.length >= 5
    const oOk = ['A','B','C','D'].every(k => (p.options[k]||'').length >= 1)
    if (!qOk || !oOk || !aOk) {
      console.log(`  ✗ Q${n}: incomplete (qlen=${p.question?.length||0}, opts=${['A','B','C','D'].map(k=>(p.options[k]||'').length).join(',')}, ans=${a||'?'})`)
      continue
    }
    out.push({ number: n, question: stripPUA(p.question),
               options: Object.fromEntries(['A','B','C','D'].map(k=>[k,stripPUA(p.options[k]||'')])),
               answer: a })
  }
  console.log(`  ✓ ready: ${out.length}/${t.nums.length}`)
  if (dryRun || out.length === 0) return out
  return out
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const onlyExam = (process.argv.find(a=>a.startsWith('--exam='))||'').split('=')[1]
  const byExam = new Map()
  for (const t of TARGETS) {
    if (onlyExam && t.exam !== onlyExam) continue
    const extracted = await processTarget(t, dryRun)
    await sleep(500)
    if (!extracted || !extracted.length) continue
    if (!byExam.has(t.exam)) byExam.set(t.exam, [])
    byExam.get(t.exam).push({ t, extracted })
  }
  if (dryRun) { console.log('\n[dry-run] no writes'); return }
  for (const [exam, items] of byExam) {
    const file = path.join(__dirname, '..', `questions-${exam}.json`)
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
    let nextId = Math.max(...data.questions.map(q=>q.id||0)) + 1
    let added = 0, replaced = 0
    for (const { t, extracted } of items) {
      for (const q of extracted) {
        const idx = data.questions.findIndex(x =>
          x.exam_code === t.code && x.subject === t.subject && x.number === q.number)
        const rec = {
          roc_year: t.year, session: t.session, exam_code: t.code,
          subject: t.subject, subject_tag: t.tag, subject_name: t.subject,
          stage_id: 0, number: q.number,
          question: q.question, options: q.options,
          answer: q.answer, explanation: '',
        }
        if (idx >= 0) {
          rec.id = data.questions[idx].id
          data.questions[idx] = rec
          replaced++
        } else {
          rec.id = nextId++
          data.questions.push(rec)
          added++
        }
      }
    }
    data.total = data.questions.length
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file)
    console.log(`\n✅ ${exam}: +${added} added, ${replaced} replaced → ${data.questions.length} total`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
