#!/usr/bin/env node
// Second-pass using parseColumnAware to:
// 1) Fill gap questions missed by text parsers in scrape-missing-020 sessions
// 2) Fix existing incomplete questions in the same sessions
// Runs on vet 102-105 and dental1/dental2 104-105 (URLs already verified).

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const { parseColumnAware } = require('./lib/moex-column-parser.js')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false, timeout: 25000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*', Referer: 'https://wwwq.moex.gov.tw/' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) { res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800)
        return reject(new Error('redirect')) }
      if (res.statusCode !== 200) { res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800)
        return reject(new Error('HTTP ' + res.statusCode)) }
      const cs = []; res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    }).on('error', e => retries > 0 ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800) : reject(e))
  })
}

async function parseAnswers(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise
  const LETTERS = new Set(['Ａ','Ｂ','Ｃ','Ｄ','A','B','C','D'])
  const toHalf = c => ({ 'Ａ':'A','Ｂ':'B','Ｃ':'C','Ｄ':'D' })[c] || c
  const letterItems = []
  for (let pi = 1; pi <= doc.numPages; pi++) {
    const page = await doc.getPage(pi)
    const content = await page.getTextContent()
    for (const it of content.items) {
      const s = it.str.trim()
      if (s.length !== 1 || !LETTERS.has(s)) continue
      letterItems.push({ str: toHalf(s), page: pi, x: it.transform[4], y: it.transform[5] })
    }
  }
  letterItems.sort((a,b) => a.page - b.page || b.y - a.y || a.x - b.x)
  const rows = []
  for (const it of letterItems) {
    const last = rows[rows.length-1]
    if (last && last.page === it.page && Math.abs(last.y - it.y) < 3) last.parts.push(it)
    else rows.push({ page: it.page, y: it.y, parts: [it] })
  }
  const ans = {}
  let n = 1
  for (const r of rows.filter(r => r.parts.length >= 10)) {
    r.parts.sort((a,b) => a.x - b.x)
    for (const p of r.parts) { if (n > 80) break; ans[n++] = p.str }
  }
  return ans
}

// Re-use TARGETS structure from scrape-missing-020
const TARGETS = [
  ...['102020','102100','103020','103090','104020'].map(code => ({
    file: 'questions-vet.json', code, roc: code.slice(0,3),
    session: /020$/.test(code) ? '第一次' : '第二次',
    stage_id: 0, c: '307',
    papers: [
      { s: '11', subject: '獸醫病理學',   tag: 'vet_pathology',     name: '獸醫病理學' },
      { s: '22', subject: '獸醫藥理學',   tag: 'vet_pharmacology',  name: '獸醫藥理學' },
      { s: '33', subject: '獸醫實驗診斷學', tag: 'vet_lab_diagnosis', name: '獸醫實驗診斷學' },
      { s: '44', subject: '獸醫普通疾病學', tag: 'vet_common_disease',name: '獸醫普通疾病學' },
      { s: '55', subject: '獸醫傳染病學',   tag: 'vet_infectious',    name: '獸醫傳染病學' },
      { s: '66', subject: '獸醫公共衛生學', tag: 'vet_public_health', name: '獸醫公共衛生學' },
    ]
  })),
  ...['104090','105020','105100'].map(code => ({
    file: 'questions-vet.json', code, roc: code.slice(0,3),
    session: '第二次', stage_id: 0, c: '314',
    papers: [
      { s: '11', subject: '獸醫病理學',   tag: 'vet_pathology',     name: '獸醫病理學' },
      { s: '22', subject: '獸醫藥理學',   tag: 'vet_pharmacology',  name: '獸醫藥理學' },
      { s: '33', subject: '獸醫實驗診斷學', tag: 'vet_lab_diagnosis', name: '獸醫實驗診斷學' },
      { s: '44', subject: '獸醫普通疾病學', tag: 'vet_common_disease',name: '獸醫普通疾病學' },
      { s: '55', subject: '獸醫傳染病學',   tag: 'vet_infectious',    name: '獸醫傳染病學' },
      { s: '66', subject: '獸醫公共衛生學', tag: 'vet_public_health', name: '獸醫公共衛生學' },
    ]
  })),
  { file: 'questions-dental2.json', code: '104020', roc: '104', session: '第一次', stage_id: 5, c: '302',
    papers: [
      { s: '33', subject: '卷一', tag: 'periodontics',              name: '牙醫學(三)' },
      { s: '44', subject: '卷二', tag: 'endodontics',               name: '牙醫學(四)' },
      { s: '55', subject: '卷三', tag: 'removable_prosthodontics',  name: '牙醫學(五)' },
      { s: '66', subject: '卷四', tag: 'dental_public_health',      name: '牙醫學(六)' },
    ]},
  { file: 'questions-dental2.json', code: '104090', roc: '104', session: '第二次', stage_id: 5, c: '304',
    papers: [
      { s: '33', subject: '卷一', tag: 'periodontics',              name: '牙醫學(三)' },
      { s: '55', subject: '卷三', tag: 'removable_prosthodontics',  name: '牙醫學(五)' },
      { s: '66', subject: '卷四', tag: 'dental_public_health',      name: '牙醫學(六)' },
    ]},
  { file: 'questions-dental2.json', code: '105020', roc: '105', session: '第一次', stage_id: 5, c: '304',
    papers: [
      { s: '33', subject: '卷一', tag: 'periodontics',              name: '牙醫學(三)' },
      { s: '44', subject: '卷二', tag: 'endodontics',               name: '牙醫學(四)' },
      { s: '55', subject: '卷三', tag: 'removable_prosthodontics',  name: '牙醫學(五)' },
      { s: '66', subject: '卷四', tag: 'dental_public_health',      name: '牙醫學(六)' },
    ]},
  { file: 'questions-dental2.json', code: '105100', roc: '105', session: '第二次', stage_id: 5, c: '304',
    papers: [
      { s: '33', subject: '卷一', tag: 'periodontics',              name: '牙醫學(三)' },
      { s: '44', subject: '卷二', tag: 'endodontics',               name: '牙醫學(四)' },
      { s: '55', subject: '卷三', tag: 'removable_prosthodontics',  name: '牙醫學(五)' },
      { s: '66', subject: '卷四', tag: 'dental_public_health',      name: '牙醫學(六)' },
    ]},
]

async function main() {
  const byFile = new Map()
  for (const t of TARGETS) { if (!byFile.has(t.file)) byFile.set(t.file, []); byFile.get(t.file).push(t) }
  for (const [file, ts] of byFile) {
    const fp = path.join(__dirname, '..', file)
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    let added = 0, fixed = 0
    for (const t of ts) {
      // Existing records for this code, indexed by subject+number
      const byKey = new Map()
      for (const q of data.questions) {
        if (q.exam_code !== t.code) continue
        byKey.set(q.subject + '|' + q.number, q)
      }
      for (const p of t.papers) {
        const qUrl = `${BASE}?t=Q&code=${t.code}&c=${t.c}&s=${p.s}&q=1`
        const aUrl = `${BASE}?t=S&code=${t.code}&c=${t.c}&s=${p.s}&q=1`
        let parsed = {}, answers = {}
        try {
          const qBuf = await fetchPdf(qUrl)
          parsed = await parseColumnAware(qBuf)
          await sleep(300)
          const aBuf = await fetchPdf(aUrl)
          answers = await parseAnswers(aBuf)
        } catch (e) { console.log(`  ⚠ ${t.code}/${p.s}: ${e.message}`); continue }
        let localAdd = 0, localFix = 0
        for (let n = 1; n <= 80; n++) {
          const pq = parsed[n]; const ans = answers[n]
          if (!pq || !ans) continue
          const opts = ['A','B','C','D'].map(k => stripPUA(pq.options[k]||''))
          if (!opts.every(o => o.length >= 2)) continue
          const key = p.subject + '|' + n
          const exist = byKey.get(key)
          if (!exist) {
            data.questions.push({
              id: `${t.code}_${p.s}_${n}`, roc_year: t.roc, session: t.session, exam_code: t.code,
              subject: p.subject, subject_tag: p.tag, subject_name: p.name, stage_id: t.stage_id,
              number: n, question: stripPUA(pq.question),
              options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] },
              answer: ans, explanation: '',
            })
            byKey.set(key, data.questions[data.questions.length-1])
            added++; localAdd++
          } else if (exist.incomplete) {
            exist.question = stripPUA(pq.question) || exist.question
            exist.options = { A: opts[0], B: opts[1], C: opts[2], D: opts[3] }
            if (!exist.answer) exist.answer = ans
            delete exist.incomplete
            delete exist.gap_reason
            fixed++; localFix++
          }
        }
        if (localAdd + localFix > 0) console.log(`  ${file} ${t.code}/${p.s}: +${localAdd} fixed ${localFix}`)
        await sleep(300)
      }
    }
    data.total = data.questions.length
    const tmp = fp + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, fp)
    console.log(`✅ ${file}: +${added} fixed ${fixed}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
