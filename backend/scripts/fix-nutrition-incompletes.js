#!/usr/bin/env node
// Recover nutrition incompletes (non-image-dep) via text-layer multi-strategy extraction.
// Uses same parser as fix-105-nursing.js (strategies A/B/C/D).

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
    // A: any cut where rest lines split by 2+ spaces → exactly 4 segs
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
    // B: last 4 lines as options
    if (lines.length >= 5) {
      const opts = lines.slice(-4)
      if (opts.every(o => o.length >= 2 && !/^[①②③④⑤]+$/.test(o))) {
        out[n] = { question: lines.slice(0, -4).join(' ').replace(/\s+/g,' ').trim(),
                   options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] } }
        continue
      }
    }
    // C: last 2 lines each 2 segs (2x2 grid)
    if (lines.length >= 3) {
      const split2 = lines.slice(-2).map(l => l.split(/\s+/).filter(Boolean))
      if (split2.every(a => a.length === 2 && a.every(s => s.length >= 2))) {
        const opts = [...split2[0], ...split2[1]]
        out[n] = { question: lines.slice(0, -2).join(' ').replace(/\s+/g,' ').trim(),
                   options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] } }
        continue
      }
    }
    // D: last line split by single space → 4 segs
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

// (code, subject) → (c, s). Derived from scrape-100-105.js + modern-era defaults.
// 106+ modern nutrition: c=102, s=0201-0206 (per scrape-moex.js subject order)
const SUBJ_TO_S_MODERN = {
  '膳食療養學': '0201', '團體膳食設計與管理': '0202', '生理學與生物化學': '0203',
  '營養學': '0204', '公共衛生營養學': '0205', '食品衛生與安全': '0206',
}
const SUBJ_TO_S_104030 = {
  '生理學與生物化學': '0301', '營養學': '0302', '膳食療養學': '0303',
  '團體膳食設計與管理': '0304', '公共衛生營養學': '0305', '食品衛生與安全': '0306',
}
const SUBJ_TO_S_104100_105 = {
  '生理學與生物化學': '0201', '營養學': '0202', '膳食療養學': '0203',
  '團體膳食設計與管理': '0204', '公共衛生營養學': '0205', '食品衛生與安全': '0206',
}
const SUBJ_TO_S_100_101 = {
  '生理學與生物化學': '0601', '營養學': '0602', '膳食療養學': '0603',
  '團體膳食設計與管理': '0604', '公共衛生營養學': '0605', '食品衛生與安全': '0606',
}

function lookupUrl(code, subject) {
  const y = code.slice(0, 3)
  const s = code.slice(3)
  if (code === '100140' || code === '101030') {
    return { c: '107', s: SUBJ_TO_S_100_101[subject] }
  }
  if (code === '104030') return { c: '106', s: SUBJ_TO_S_104030[subject] }
  if (code === '104100') return { c: '103', s: SUBJ_TO_S_104100_105[subject] }
  if (code === '105030' || code === '105090') {
    return { c: '103', s: SUBJ_TO_S_104100_105[subject] }
  }
  // 106+ modern
  return { c: '102', s: SUBJ_TO_S_MODERN[subject] }
}

async function main() {
  const fp = path.join(__dirname, '..', 'questions-nutrition.json')
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const targets = data.questions.filter(q => q.incomplete && q.gap_reason !== 'missing_image_dep')
  // Group by (code, subject)
  const groups = new Map()
  for (const q of targets) {
    const k = `${q.exam_code}|${q.subject}`
    if (!groups.has(k)) groups.set(k, { code: q.exam_code, subject: q.subject, items: [] })
    groups.get(k).items.push(q)
  }
  let fixed = 0, tried = 0
  const cache = new Map()
  for (const [k, g] of groups) {
    const { c, s } = lookupUrl(g.code, g.subject) || {}
    if (!c || !s) { console.log(`skip ${k}: no mapping`); continue }
    const url = `${BASE}?t=Q&code=${g.code}&c=${c}&s=${s}&q=1`
    let parsed
    if (cache.has(url)) parsed = cache.get(url)
    else {
      try {
        const buf = await fetchPdf(url)
        const { text } = await pdfParse(buf)
        if (text.length < 500) { console.log(`⚠ ${k}: short text`); cache.set(url, {}); await sleep(300); continue }
        parsed = extractFromText(text)
        cache.set(url, parsed)
      } catch (e) { console.log(`⚠ ${k}: ${e.message}`); cache.set(url, {}); await sleep(300); continue }
      await sleep(300)
    }
    let localFixed = 0
    for (const q of g.items) {
      tried++
      const pq = parsed[q.number]
      if (!pq || !['A','B','C','D'].every(kk => (pq.options[kk]||'').length >= 2)) continue
      q.options = Object.fromEntries(['A','B','C','D'].map(kk => [kk, stripPUA(pq.options[kk])]))
      q.question = stripPUA(pq.question) || q.question
      delete q.incomplete
      delete q.gap_reason
      fixed++; localFixed++
    }
    console.log(`${k}: parsed=${Object.keys(parsed).length}, tried=${g.items.length}, fixed=${localFixed}`)
  }
  data.total = data.questions.length
  const tmp = fp + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, fp)
  console.log(`\n✅ nutrition: ${fixed}/${tried} recovered`)
}

main().catch(e => { console.error(e); process.exit(1) })
