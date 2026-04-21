#!/usr/bin/env node
// Nutrition 100-1 is 申論+測驗 mixed, 40 選擇 per subject, no A/B/C/D labels.
// Use column-aware parser; parseColumnAware anchors on Q numbers, so 申論 (一、二、三) is ignored.

const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')
const { parseColumnAware } = require('./lib/moex-column-parser')

const NUT_FILE = path.join(__dirname, '..', 'questions-nutrition.json')

const SUBJECTS = [
  { s: '0701', subject: '生理學與生物化學', tag: 'physio_biochem' },
  { s: '0702', subject: '營養學', tag: 'nutrition_science' },
  { s: '0703', subject: '膳食療養學', tag: 'diet_therapy' },
  { s: '0704', subject: '團體膳食設計與管理', tag: 'group_meal' },
  { s: '0705', subject: '公共衛生營養學', tag: 'public_nutrition' },
  { s: '0706', subject: '食品衛生與安全', tag: 'food_safety' },
]

const CODE = '100030'
const C = '108'
const YEAR = '100'
const SESSION = '第一次'

function download(url) {
  return new Promise((res, rej) => {
    https.get(url, { rejectUnauthorized: false }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400) return rej(new Error('redir ' + r.statusCode))
      const cs = []
      r.on('data', c => cs.push(c))
      r.on('end', () => res(Buffer.concat(cs)))
      r.on('error', rej)
    }).on('error', rej)
  })
}

function parseAnswers(text) {
  const rows = text.match(/答案[ＡＢＣＤ#＃A-D]+/g) || []
  const toHalf = s => s.replace(/Ａ/g,'A').replace(/Ｂ/g,'B').replace(/Ｃ/g,'C').replace(/Ｄ/g,'D').replace(/＃/g,'#')
  const answers = {}
  let n = 1
  for (const row of rows) {
    const seq = toHalf(row.replace('答案', ''))
    for (const ch of seq) {
      if (n <= 40) answers[n] = ch
      n++
    }
  }
  const disputed = new Set()
  const corrections = {}
  const noteMatch = text.match(/備\s*[　 ]?\s*註[：:]([^\n]+)/)
  if (noteMatch) {
    for (const item of noteMatch[1].split(/[，,]/)) {
      const mAll = item.match(/第(\d+)題一律給分/)
      if (mAll) { disputed.add(parseInt(mAll[1])); continue }
      const mDual = item.match(/第(\d+)題答([ABCDＡＢＣＤ])[、,．]([ABCDＡＢＣＤ])給分/)
      if (mDual) { disputed.add(parseInt(mDual[1])); corrections[parseInt(mDual[1])] = toHalf(mDual[2]) }
    }
  }
  return { answers, disputed, corrections }
}

async function scrapeSubject(sub) {
  const qUrl = `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=Q&code=${CODE}&c=${C}&s=${sub.s}&q=1`
  const qBuf = await download(qUrl)
  const qTextCheck = (await pdfParse(qBuf)).text.slice(0, 500)
  if (!qTextCheck.includes('營養師')) {
    console.warn(`WRONG EXAM s=${sub.s}`)
    return []
  }
  const parsed = await parseColumnAware(qBuf)

  let aBuf
  for (const t of ['S', 'M', 'A']) {
    try {
      aBuf = await download(`https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=${t}&code=${CODE}&c=${C}&s=${sub.s}&q=1`)
      break
    } catch (e) {}
  }
  if (!aBuf) { console.warn(`No answer PDF s=${sub.s}`); return [] }
  const aText = (await pdfParse(aBuf)).text
  const { answers, disputed, corrections } = parseAnswers(aText)

  const results = []
  const nums = Object.keys(parsed).map(n => parseInt(n)).sort((a,b) => a-b)
  for (const num of nums) {
    if (num > 40) continue
    const p = parsed[num]
    if (!p || !p.question || !p.options.A || !p.options.B || !p.options.C || !p.options.D) continue
    const ansRaw = answers[num]
    const ans = corrections[num] || (ansRaw === '#' || ansRaw === '＃' || !ansRaw ? 'A' : ansRaw)
    const q = {
      id: `${CODE}_${sub.s}_${num}`,
      roc_year: YEAR,
      session: SESSION,
      exam_code: CODE,
      subject: sub.subject,
      subject_tag: sub.tag,
      subject_name: sub.subject,
      stage_id: 0,
      number: num,
      question: p.question,
      options: p.options,
      answer: ans,
      explanation: '',
    }
    if (disputed.has(num)) q.disputed = true
    results.push(q)
  }
  console.log(`${sub.subject}: ${Object.keys(parsed).length} parsed → ${results.length} clean`)
  return results
}

async function main() {
  const bank = JSON.parse(fs.readFileSync(NUT_FILE, 'utf8'))
  const arr = bank.questions || bank

  const newQs = []
  for (const sub of SUBJECTS) {
    const got = await scrapeSubject(sub)
    newQs.push(...got)
  }

  const keep = arr.filter(q => !(q.exam_code === CODE && q.session === SESSION))
  console.log(`\nRemoved ${arr.length - keep.length} old, added ${newQs.length} new`)
  const merged = keep.concat(newQs)
  if (bank.questions) bank.questions = merged
  const tmp = NUT_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(bank.questions ? bank : merged, null, 2))
  fs.renameSync(tmp, NUT_FILE)
  console.log('Wrote', NUT_FILE, '—', merged.length, 'total')
}

main().catch(e => { console.error(e); process.exit(1) })
