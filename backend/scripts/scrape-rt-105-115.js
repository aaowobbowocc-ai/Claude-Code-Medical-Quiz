#!/usr/bin/env node
/**
 * 爬 RT 呼吸治療師 105-113 年（c=313）的 84 個 papers。
 * PDFs 已由 probe-rt-105-115.js 存到 _tmp/pdf-cache/。
 * 邏輯沿用 scrape-100-105 的 pipeline：parse Q + S + M，dedup，寫入 questions-rt.json。
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')
const { parseColumnAware, parseAnswersColumnAware } = require('./lib/moex-column-parser')
const { atomicWriteJson } = require('./lib/atomic-write')
const { parseQuestions, parseAnswers, parseCorrections, stripPUA } = require('./lib/pdf-question-parser')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')
const SUBJECTS_BY_S = {
  '11': { subject: '心肺基礎醫學', tag: 'rt_basic_cardiopulm', name: '心肺基礎醫學' },
  '22': { subject: '基礎呼吸治療學', tag: 'rt_basic_therapy', name: '基礎呼吸治療學' },
  '33': { subject: '呼吸治療儀器設備學', tag: 'rt_equipment', name: '呼吸治療儀器設備學' },
  '44': { subject: '呼吸器原理及應用', tag: 'rt_ventilator', name: '呼吸器原理及應用' },
  '55': { subject: '重症呼吸治療學', tag: 'rt_critical', name: '重症呼吸治療學' },
  '66': { subject: '呼吸疾病學', tag: 'rt_diseases', name: '呼吸疾病學' },
}

// 場次 → (year, session)
const SESSIONS = [
  ['105020', '105', '第一次'], ['105100', '105', '第二次'],
  ['106020', '106', '第一次'], ['106100', '106', '第二次'],
  ['107020', '107', '第一次'], ['107100', '107', '第二次'],
  ['108030', '108', '第一次'], ['108100', '108', '第二次'],
  ['109020', '109', '第一次'], ['109100', '109', '第二次'],
  ['110100', '110', '第二次'],
  ['111100', '111', '第二次'],
  ['112100', '112', '第二次'],
  ['113090', '113', '第二次'],
]
const C_CODE = '313'

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, r => {
      if (r.statusCode !== 200) { r.destroy(); return res(null) }
      const ch = []; r.on('data', c => ch.push(c)); r.on('end', () => res(Buffer.concat(ch)))
    }).on('error', rej)
  })
}

async function getCachedOrDownload(kind, code, c, s) {
  // Q: rt_<code>_c<c>_s<s>_Q.pdf or Q_<code>_c<c>_s<s>.pdf
  const namesQ = [`Q_${code}_c${c}_s${s}.pdf`, `rt_${code}_c${c}_s${s}_Q.pdf`]
  const namesS = [`S_${code}_c${c}_s${s}.pdf`, `rt_${code}_c${c}_s${s}_S.pdf`, `A_${code}_c${c}_s${s}.pdf`]
  const namesM = [`M_${code}_c${c}_s${s}.pdf`, `rt_${code}_c${c}_s${s}_M.pdf`]
  const names = kind === 'Q' ? namesQ : kind === 'S' ? namesS : namesM
  for (const name of names) {
    const fp = path.join(PDF_CACHE, name)
    if (fs.existsSync(fp)) return fs.readFileSync(fp)
  }
  // Download from MoEX
  const url = `${BASE}?t=${kind}&code=${code}&c=${c}&s=${s}&q=1`
  const buf = await get(url).catch(() => null)
  if (buf && buf.length > 1000) {
    const fp = path.join(PDF_CACHE, `${kind === 'Q' ? 'Q' : kind === 'S' ? 'S' : 'M'}_${code}_c${c}_s${s}.pdf`)
    fs.writeFileSync(fp, buf)
    return buf
  }
  return null
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const fp = path.join(__dirname, '..', 'questions-rt.json')
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || []
  let nextId = arr.reduce((m, q) => Math.max(m, parseInt(q.id) || 0), 0) + 1

  const existingKeys = new Set(arr.map(q => `${q.roc_year}_${q.exam_code}_${q.subject_tag}_${q.number}`))
  let added = 0

  for (const [code, year, session] of SESSIONS) {
    console.log(`\n--- ${year}年${session} (${code}) ---`)
    for (const [s, sub] of Object.entries(SUBJECTS_BY_S)) {
      const dupKey = `${year}_${code}_${sub.tag}_1`
      // crude dedup pre-check (just paper-level)

      const qBuf = await getCachedOrDownload('Q', code, C_CODE, s)
      if (!qBuf) { console.log(`  ✗ ${sub.name}: no Q PDF`); continue }

      // Validate exam name
      try {
        const text = (await pdfParse(qBuf)).text.slice(0, 500).normalize('NFKC')
        if (!text.includes('呼吸治療')) {
          console.log(`  ✗ ${sub.name}: PDF 類科不對`)
          continue
        }
      } catch {}

      // Parse questions — try labelled then column-aware
      let parsedMap = {}
      try {
        const text = (await pdfParse(qBuf)).text
        const questions = parseQuestions(text, { maxQNum: 200 })
        for (const q of questions) parsedMap[q.number] = q
      } catch {}
      if (Object.keys(parsedMap).length < 10) {
        try {
          parsedMap = await parseColumnAware(qBuf)
        } catch {}
      }

      // Parse answers
      let answers = {}
      for (const ansType of ['S', 'A']) {
        const aBuf = await getCachedOrDownload(ansType, code, C_CODE, s)
        if (!aBuf) continue
        try {
          const text = (await pdfParse(aBuf)).text
          const tmp = parseAnswers(text, { maxQNum: 200 })
          if (Object.keys(tmp).length > Object.keys(answers).length) answers = tmp
          if (Object.keys(answers).length < 20) {
            const col = await parseAnswersColumnAware(aBuf).catch(() => ({}))
            if (Object.keys(col).length > Object.keys(answers).length) answers = col
          }
        } catch {}
        if (Object.keys(answers).length >= 50) break
      }

      // Corrections
      const disputed = new Set()
      const mBuf = await getCachedOrDownload('M', code, C_CODE, s).catch(() => null)
      if (mBuf) {
        try {
          const text = (await pdfParse(mBuf)).text
          const corrs = parseCorrections(text)
          for (const [num, ans] of Object.entries(corrs)) {
            if (ans === '*') disputed.add(parseInt(num))
            else answers[num] = ans
          }
        } catch {}
      }

      // Build output
      let pAdded = 0
      for (const [num, q] of Object.entries(parsedMap)) {
        const n = parseInt(num)
        const ans = answers[n]
        if (!ans) continue
        const k = `${year}_${code}_${sub.tag}_${n}`
        if (existingKeys.has(k)) continue
        const opts = q.options || {}
        const cleanOpts = {}
        for (const x of ['A', 'B', 'C', 'D']) cleanOpts[x] = stripPUA(opts[x] || '')
        arr.push({
          id: `${code}_${s}_${n}`,
          roc_year: year, session, exam_code: code, class_code: C_CODE,
          subject: sub.subject, subject_tag: sub.tag, subject_name: sub.name,
          stage_id: 0, number: n,
          question: stripPUA(q.question || ''),
          options: cleanOpts, answer: ans,
          explanation: '',
          ...(disputed.has(n) ? { disputed: true } : {}),
        })
        existingKeys.add(k)
        pAdded++
      }
      console.log(`  ✓ ${sub.name}: +${pAdded} 題 (parsed ${Object.keys(parsedMap).length}, answers ${Object.keys(answers).length})`)
      added += pAdded
      await sleep(200)
    }
  }

  data.questions = arr
  data.total = arr.length
  atomicWriteJson(fp, data)
  console.log(`\n=== 總計新增 ${added} 題，questions-rt.json 現有 ${arr.length} 題 ===`)
}

main().catch(e => { console.error(e); process.exit(1) })
