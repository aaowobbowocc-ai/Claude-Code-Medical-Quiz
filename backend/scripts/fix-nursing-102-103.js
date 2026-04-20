#!/usr/bin/env node
// Fill missing nursing questions for 102030 / 102110 / 103030 / 103100.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')
const { parseColumnAware } = require('./lib/moex-column-parser.js')

const UA = 'Mozilla/5.0 Chrome/131.0.0.0'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false, timeout: 25000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*', Referer: 'https://wwwq.moex.gov.tw/' } }, res => {
      if (res.statusCode !== 200) { res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800)
        return reject(new Error('HTTP ' + res.statusCode)) }
      const cs = []; res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    }).on('error', e => retries > 0 ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800) : reject(e))
  })
}

async function parseAnswersPdfJs(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise
  const LETTERS = new Set(['Ａ','Ｂ','Ｃ','Ｄ','A','B','C','D'])
  const toHalf = c => ({ 'Ａ':'A','Ｂ':'B','Ｃ':'C','Ｄ':'D' })[c] || c
  const items = []
  for (let pi = 1; pi <= doc.numPages; pi++) {
    const page = await doc.getPage(pi)
    const content = await page.getTextContent()
    for (const it of content.items) {
      const s = it.str.trim()
      if (s.length !== 1 || !LETTERS.has(s)) continue
      items.push({ str: toHalf(s), page: pi, x: it.transform[4], y: it.transform[5] })
    }
  }
  items.sort((a,b) => a.page - b.page || b.y - a.y || a.x - b.x)
  const rows = []
  for (const it of items) {
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

const TARGETS = [
  { code: '102030', session: '第一次', c: '110', papers: [
    { s: '0108', subject: '基礎醫學',               tag: 'basic_medicine' },
    { s: '0601', subject: '基本護理學與護理行政',   tag: 'basic_nursing' },
    { s: '0602', subject: '內外科護理學',           tag: 'med_surg' },
    { s: '0603', subject: '產兒科護理學',           tag: 'maternal_pediatric' },
    { s: '0604', subject: '精神科與社區衛生護理學', tag: 'psychiatric_community' },
  ]},
  { code: '102110', session: '第二次', c: '109', papers: [
    { s: '0501', subject: '基本護理學與護理行政',   tag: 'basic_nursing' },
    { s: '0502', subject: '內外科護理學',           tag: 'med_surg' },
    { s: '0503', subject: '產兒科護理學',           tag: 'maternal_pediatric' },
    { s: '0504', subject: '精神科與社區衛生護理學', tag: 'psychiatric_community' },
  ]},
  { code: '103030', session: '第一次', c: '109', papers: [
    { s: '0501', subject: '基本護理學與護理行政',   tag: 'basic_nursing' },
    { s: '0502', subject: '內外科護理學',           tag: 'med_surg' },
    { s: '0503', subject: '產兒科護理學',           tag: 'maternal_pediatric' },
    { s: '0504', subject: '精神科與社區衛生護理學', tag: 'psychiatric_community' },
  ]},
  { code: '103100', session: '第二次', c: '109', papers: [
    { s: '0501', subject: '基本護理學與護理行政',   tag: 'basic_nursing' },
    { s: '0502', subject: '內外科護理學',           tag: 'med_surg' },
    { s: '0503', subject: '產兒科護理學',           tag: 'maternal_pediatric' },
    { s: '0504', subject: '精神科與社區衛生護理學', tag: 'psychiatric_community' },
  ]},
]

async function main() {
  const fp = path.join(__dirname, '..', 'questions-nursing.json')
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  let maxId = data.questions.reduce((m, q) => {
    const n = typeof q.id === 'number' ? q.id : parseInt(String(q.id).split('_')[0], 10)
    return isNaN(n) ? m : Math.max(m, n)
  }, 0)
  let total = 0
  for (const t of TARGETS) {
    console.log(`\n=== ${t.code} (${t.session}, c=${t.c}) ===`)
    for (const p of t.papers) {
      const existNums = new Set(data.questions
        .filter(q => q.exam_code === t.code && q.subject === p.subject).map(q => q.number))
      const qUrl = `${BASE}?t=Q&code=${t.code}&c=${t.c}&s=${p.s}&q=1`
      const aUrl = `${BASE}?t=S&code=${t.code}&c=${t.c}&s=${p.s}&q=1`
      let qBuf, aBuf
      try {
        qBuf = await fetchPdf(qUrl)
        const rawText = (await pdfParse(qBuf).catch(() => ({text:''}))).text.slice(0, 400).normalize('NFKC')
        if (rawText && !rawText.includes('護理師')) {
          console.log(`  ${p.subject}: 類科不是護理師，跳過`)
          continue
        }
        await sleep(300)
        aBuf = await fetchPdf(aUrl)
      } catch(e) { console.log(`  ${p.subject}: 下載失敗 ${e.message}`); continue }
      let parsed = {}
      try { parsed = await parseColumnAware(qBuf) } catch(e) { console.log(`  ${p.subject}: parser 失敗 ${e.message}`); continue }
      let answers = {}
      try { answers = await parseAnswersPdfJs(aBuf) } catch(e) { console.log(`  ${p.subject}: 答案解析失敗 ${e.message}`) }
      const good = Object.values(parsed).filter(q => ['A','B','C','D'].every(k => (q.options[k]||'').length >= 1)).length
      console.log(`  ${p.subject}: 題目 ${good}/80, 答案 ${Object.keys(answers).length}, 既有 ${existNums.size}`)
      let localAdd = 0
      for (let n = 1; n <= 80; n++) {
        if (existNums.has(n)) continue
        const pq = parsed[n]; const ans = answers[n]
        if (!pq || !ans) continue
        const opts = ['A','B','C','D'].map(k => stripPUA(pq.options[k]||''))
        if (!opts.every(o => o.length >= 1)) continue
        maxId++
        data.questions.push({
          id: maxId,
          roc_year: t.code.slice(0,3), session: t.session, exam_code: t.code,
          subject: p.subject, subject_tag: p.tag, subject_name: p.subject,
          stage_id: 0, number: n,
          question: stripPUA(pq.question),
          options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] },
          answer: ans, explanation: '',
        })
        total++; localAdd++
      }
      console.log(`    +${localAdd}`)
      await sleep(300)
    }
  }
  data.total = data.questions.length
  if (data.metadata) data.metadata.last_updated = new Date().toISOString()
  fs.writeFileSync(fp + '.tmp', JSON.stringify(data, null, 2))
  fs.renameSync(fp + '.tmp', fp)
  console.log(`\n✅ nursing 102/103: added ${total} (total ${data.total})`)
}
main().catch(e => { console.error(e); process.exit(1) })
