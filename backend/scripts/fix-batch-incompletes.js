#!/usr/bin/env node
// Batch fix remaining non-image incompletes using multi-strategy text parser.
// Reuses parser from fix-105-nursing.js. Targets biggest remaining buckets per CLAUDE.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false, timeout: 25000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*', Referer: 'https://wwwq.moex.gov.tw/' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800)
        return reject(new Error('redirect'))
      }
      if (res.statusCode !== 200) {
        res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800)
        return reject(new Error('HTTP ' + res.statusCode))
      }
      const cs = []; res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    }).on('error', e => retries > 0 ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800) : reject(e))
  })
}

function extractFromText(text) {
  const out = {}
  const cleaned = text.replace(/代號[：:]\s*\d+\s*\n/g, '').replace(/頁次[：:]\s*\d+－\d+\s*\n/g, '')
  for (let n = 1; n <= 80; n++) {
    const re = new RegExp(`\\n\\s*${n}\\s+([\\s\\S]*?)\\n\\s*${n + 1}\\s`, 'm')
    const m = cleaned.match(re)
    if (!m) continue
    const lines = m[1].split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length < 2) continue
    let matched = false
    for (let k = 1; k < lines.length; k++) {
      const segs = []
      for (const l of lines.slice(k)) segs.push(...l.split(/\s{2,}/).filter(Boolean))
      if (segs.length === 4 && segs.every(s => s.length >= 1)) {
        out[n] = { question: lines.slice(0, k).join(' ').replace(/\s+/g,' ').trim(),
                   options: { A: segs[0], B: segs[1], C: segs[2], D: segs[3] } }
        matched = true; break
      }
    }
    if (matched) continue
    if (lines.length >= 5) {
      const opts = lines.slice(-4)
      if (opts.every(o => o.length >= 2 && !/^[①②③④⑤]+$/.test(o))) {
        out[n] = { question: lines.slice(0, -4).join(' ').replace(/\s+/g,' ').trim(),
                   options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] } }
        continue
      }
    }
    if (lines.length >= 3) {
      const split2 = lines.slice(-2).map(l => l.split(/\s+/).filter(Boolean))
      if (split2.every(a => a.length === 2 && a.every(s => s.length >= 2))) {
        const opts = [...split2[0], ...split2[1]]
        out[n] = { question: lines.slice(0, -2).join(' ').replace(/\s+/g,' ').trim(),
                   options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] } }
        continue
      }
    }
    if (lines.length >= 2) {
      const segs = lines[lines.length - 1].split(/\s+/).filter(Boolean)
      if (segs.length === 4 && segs.every(s => s.length >= 1)) {
        out[n] = { question: lines.slice(0, -1).join(' ').replace(/\s+/g,' ').trim(),
                   options: { A: segs[0], B: segs[1], C: segs[2], D: segs[3] } }
      }
    }
  }
  return out
}

const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s
const sleep = ms => new Promise(r => setTimeout(r, ms))

// URL lookup — returns {c, s} from (file, exam_code, subject) or null.
// Derived from scrape-100-105.js + CLAUDE mappings.
function lookupUrl(file, code, subject) {
  const sw = { '社會工作': '0601', '社會工作直接服務': '0602', '社會工作管理': '0603' }
  if (file === 'questions-social-worker.json') {
    if (code === '104030') return { c: '110', s: sw[subject] }
    if (code === '104100' || code === '105030' || code === '105090') return { c: '107', s: sw[subject] }
  }
  const ns = { '基礎醫學': '0501', '基本護理學與護理行政': '0502', '內外科護理學': '0503', '產兒科護理學': '0504', '精神科與社區衛生護理學': '0505' }
  if (file === 'questions-nursing.json') {
    if (code === '104100' || code === '105030' || code === '105090') return { c: '106', s: ns[subject] }
    if (code === '104030') {
      // 104030 c=109 s=0501-0504 (4 papers in this session)
      const m = { '基礎醫學': '0501', '基本護理學與護理行政': '0502', '內外科護理學': '0503', '產兒科護理學': '0504', '精神科與社區衛生護理學': '0505' }
      return { c: '109', s: m[subject] }
    }
  }
  const tcm1s = { '中醫基礎醫學(一)': '0101', '中醫基礎醫學(二)': '0102' }
  if (file === 'questions-tcm1.json') {
    // 100030: c=107 中醫師 (per CLAUDE); s=0501/0502 per convention
    if (code === '100030') return { c: '107', s: subject === '中醫基礎醫學(一)' ? '0501' : '0502' }
    // 101030: c=106 中醫師(一)/合併 per CLAUDE; s=0501/0502
    if (code === '101030') return { c: '106', s: subject === '中醫基礎醫學(一)' ? '0501' : '0502' }
    if (code === '105030' || code === '105090') return { c: '101', s: tcm1s[subject] }
  }
  // doctor1 030 series
  if (file === 'questions.json' && code === '100030') {
    return { c: '101', s: subject === '醫學(一)' ? '0101' : '0102' }
  }
  if (file === 'questions.json' && code === '103030') {
    return { c: '101', s: subject === '醫學(一)' ? '0101' : '0102' }
  }
  // doctor1 020 series (modern): c=301
  if (file === 'questions.json' && /^(1[0-1][0-9]|11[0-5])(020|090|100)$/.test(code)) {
    return { c: '301', s: subject === '醫學(一)' ? '11' : '22', twoDigit: true }
  }
  // doctor2 020 series: c=302
  if (file === 'questions-doctor2.json' && /^1[0-1][0-9](020|080|090|100)$/.test(code)) {
    const map = { '醫學(三)': '11', '醫學(四)': '22', '醫學(五)': '33', '醫學(六)': '44' }
    return { c: '302', s: map[subject], twoDigit: true }
  }
  const tcm2s = { '中醫臨床醫學(一)': '0203', '中醫臨床醫學(二)': '0204', '中醫臨床醫學(三)': '0205', '中醫臨床醫學(四)': '0206' }
  if (file === 'questions-tcm2.json') {
    if (code === '105030' || code === '105090') return { c: '102', s: tcm2s[subject] }
  }
  const ns2 = { '生理學與生物化學': '0201', '營養學': '0202', '膳食療養學': '0203', '團體膳食設計與管理': '0204', '公共衛生營養學': '0205', '食品衛生與安全': '0206' }
  if (file === 'questions-nutrition.json') {
    if (code === '104100' || code === '105030' || code === '105090') return { c: '103', s: ns2[subject] }
  }
  const pharma1_100 = { '卷一': ['11','22'], '卷二': ['33','44'], '卷三': ['55','66'] }
  // pharma1 uses 020 series with 2-digit s codes — skip in this pass (different parser needed)
  const ots = { '解剖學與生理學': '11', '職能治療學概論': '22', '生理疾病職能治療學': '33', '心理疾病職能治療學': '44', '小兒疾病職能治療學': '55', '職能治療技術學': '66' }
  if (file === 'questions-ot.json' && ['101010','102020','103020','103090'].includes(code)) {
    return { c: '305', s: ots[subject], twoDigit: true }
  }
  const rads = { '基礎醫學（包括解剖學、生理學與病理學）': '11', '醫學物理學與輻射安全': '22', '放射線器材學（包括磁振學與超音波學）': '33', '放射線診斷原理與技術學': '44', '放射線治療原理與技術學': '55', '核子醫學診療原理與技術學': '66' }
  if (file === 'questions-radiology.json' && ['103020','104020'].includes(code)) {
    return { c: '308', s: rads[subject], twoDigit: true }
  }
  const pharma1_020 = { '卷一': '11', '卷二': '33', '卷三': '55' }
  if (file === 'questions-pharma1.json' && ['103090','104020'].includes(code)) {
    return { c: '306', s: pharma1_020[subject], twoDigit: true }
  }
  if (file === 'questions-pharma1.json' && code === '101030') {
    return { c: '103', s: { '卷一': '0101', '卷二': '0103', '卷三': '0105' }[subject] }
  }
  if (file === 'questions-pharma1.json' && code === '100030') {
    return { c: '103', s: { '卷一': '0101', '卷二': '0103', '卷三': '0105' }[subject] }
  }
  const dens = { '卷一': '11', '卷二': '22' }
  if (file === 'questions-dental2.json' && ['109100'].includes(code)) {
    // 109100 is 020-second-session — dental uses c=301 or different — probe
    return { c: '301', s: dens[subject], twoDigit: true }
  }
  return null
}

async function main() {
  const files = [
    'questions.json','questions-doctor2.json',
    'questions-social-worker.json','questions-nursing.json','questions-nutrition.json',
    'questions-tcm1.json','questions-tcm2.json','questions-ot.json',
    'questions-radiology.json','questions-pharma1.json','questions-dental2.json'
  ]
  const cache = new Map()
  let grandFixed = 0, grandTried = 0
  for (const file of files) {
    const fp = path.join(__dirname, '..', file)
    if (!fs.existsSync(fp)) continue
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    const targets = data.questions.filter(q => q.incomplete && q.gap_reason !== 'missing_image_dep' && q.gap_reason !== 'contaminated_tcm_source')
    if (!targets.length) continue
    // Group by code+subject
    const groups = new Map()
    for (const q of targets) {
      const k = `${q.exam_code}|${q.subject}`
      if (!groups.has(k)) groups.set(k, { code: q.exam_code, subject: q.subject, items: [] })
      groups.get(k).items.push(q)
    }
    let fileFixed = 0, fileTried = 0
    for (const [k, g] of groups) {
      const lk = lookupUrl(file, g.code, g.subject)
      if (!lk || !lk.s) continue
      const url = `${BASE}?t=Q&code=${g.code}&c=${lk.c}&s=${lk.s}&q=1`
      let parsed
      if (cache.has(url)) parsed = cache.get(url)
      else {
        try {
          const buf = await fetchPdf(url)
          const { text } = await pdfParse(buf)
          if (text.length < 500) { cache.set(url, {}); await sleep(300); continue }
          parsed = extractFromText(text)
          cache.set(url, parsed)
        } catch (e) { cache.set(url, {}); await sleep(300); continue }
        await sleep(300)
      }
      let localFixed = 0
      for (const q of g.items) {
        fileTried++; grandTried++
        const pq = parsed[q.number]
        if (!pq || !['A','B','C','D'].every(kk => (pq.options[kk]||'').length >= 2)) continue
        q.options = Object.fromEntries(['A','B','C','D'].map(kk => [kk, stripPUA(pq.options[kk])]))
        q.question = stripPUA(pq.question) || q.question
        delete q.incomplete
        delete q.gap_reason
        fileFixed++; grandFixed++; localFixed++
      }
      if (localFixed > 0) console.log(`  ${file} ${k}: ${localFixed}/${g.items.length}`)
    }
    if (fileFixed > 0) {
      data.total = data.questions.length
      const tmp = fp + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
      fs.renameSync(tmp, fp)
      console.log(`✅ ${file}: ${fileFixed}/${fileTried}`)
    }
  }
  console.log(`\n=== 總計: ${grandFixed}/${grandTried} 修復 ===`)
}

main().catch(e => { console.error(e); process.exit(1) })
