#!/usr/bin/env node
/**
 * 補 RT 缺年：104-第二次 (c=313 舊格式 s=11..66) + 114-第二次 (c=313 新格式 s=0901..0906)
 * 沿用 scrape-rt-105-115 的 pipeline。
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

const OLD = {
  '11': { subject: '心肺基礎醫學', tag: 'rt_basic_cardiopulm', name: '心肺基礎醫學' },
  '22': { subject: '基礎呼吸治療學', tag: 'rt_basic_therapy', name: '基礎呼吸治療學' },
  '33': { subject: '呼吸治療儀器設備學', tag: 'rt_equipment', name: '呼吸治療儀器設備學' },
  '44': { subject: '呼吸器原理及應用', tag: 'rt_ventilator', name: '呼吸器原理及應用' },
  '55': { subject: '重症呼吸治療學', tag: 'rt_critical', name: '重症呼吸治療學' },
  '66': { subject: '呼吸疾病學', tag: 'rt_diseases', name: '呼吸疾病學' },
}
const NEW = {
  '0901': OLD['11'],
  '0902': OLD['22'],
  '0903': OLD['33'],
  '0904': OLD['44'],
  '0905': OLD['55'],
  '0906': OLD['66'],
}

const SESSIONS = [
  { code: '104090', year: '104', session: '第二次', subjects: OLD },
  { code: '114090', year: '114', session: '第二次', subjects: NEW },
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
  const names = [`${kind}_${code}_c${c}_s${s}.pdf`, `rt_${code}_c${c}_s${s}_${kind}.pdf`]
  for (const name of names) {
    const fp = path.join(PDF_CACHE, name)
    if (fs.existsSync(fp)) return fs.readFileSync(fp)
  }
  const url = `${BASE}?t=${kind}&code=${code}&c=${c}&s=${s}&q=1`
  const buf = await get(url).catch(() => null)
  if (buf && buf.length > 1000) {
    fs.writeFileSync(path.join(PDF_CACHE, `${kind}_${code}_c${c}_s${s}.pdf`), buf)
    return buf
  }
  return null
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const fp = path.join(__dirname, '..', 'questions-rt.json')
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || []
  const existingKeys = new Set(arr.map(q => `${q.roc_year}_${q.exam_code}_${q.subject_tag}_${q.number}`))
  let added = 0

  for (const sess of SESSIONS) {
    console.log(`\n--- ${sess.year}年${sess.session} (${sess.code}) ---`)
    for (const [s, sub] of Object.entries(sess.subjects)) {
      const qBuf = await getCachedOrDownload('Q', sess.code, C_CODE, s)
      if (!qBuf) { console.log(`  ✗ ${sub.name}: no Q PDF`); continue }

      try {
        const head = (await pdfParse(qBuf)).text.slice(0, 500).normalize('NFKC')
        if (!head.includes('呼吸治療')) { console.log(`  ✗ ${sub.name}: 類科不符`); continue }
      } catch {}

      let parsedMap = {}
      try {
        const text = (await pdfParse(qBuf)).text
        for (const q of parseQuestions(text, { maxQNum: 200 })) parsedMap[q.number] = q
      } catch {}
      if (Object.keys(parsedMap).length < 10) {
        try { parsedMap = await parseColumnAware(qBuf) } catch {}
      }

      let answers = {}
      for (const ansType of ['S', 'A']) {
        const aBuf = await getCachedOrDownload(ansType, sess.code, C_CODE, s)
        if (!aBuf) continue
        try {
          const txt = (await pdfParse(aBuf)).text
          const tmp = parseAnswers(txt, { maxQNum: 200 })
          if (Object.keys(tmp).length > Object.keys(answers).length) answers = tmp
          if (Object.keys(answers).length < 20) {
            const col = await parseAnswersColumnAware(aBuf).catch(() => ({}))
            if (Object.keys(col).length > Object.keys(answers).length) answers = col
          }
        } catch {}
        if (Object.keys(answers).length >= 50) break
      }

      const disputed = new Set()
      const mBuf = await getCachedOrDownload('M', sess.code, C_CODE, s).catch(() => null)
      if (mBuf) {
        try {
          const txt = (await pdfParse(mBuf)).text
          for (const [num, ans] of Object.entries(parseCorrections(txt))) {
            if (ans === '*') disputed.add(parseInt(num))
            else answers[num] = ans
          }
        } catch {}
      }

      let pAdded = 0
      for (const [num, q] of Object.entries(parsedMap)) {
        const n = parseInt(num)
        const ans = answers[n]
        if (!ans) continue
        const k = `${sess.year}_${sess.code}_${sub.tag}_${n}`
        if (existingKeys.has(k)) continue
        const opts = q.options || {}
        const cleanOpts = {}
        for (const x of ['A', 'B', 'C', 'D']) cleanOpts[x] = stripPUA(opts[x] || '')
        arr.push({
          id: `${sess.code}_${s}_${n}`,
          roc_year: sess.year, session: sess.session, exam_code: sess.code, class_code: C_CODE,
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
