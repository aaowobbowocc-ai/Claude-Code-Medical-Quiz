#!/usr/bin/env node
// Fix customs English questions missing option D
// These are vocabulary-grid format: each row = [questionNum, optA, optB, optC, optD]
// with invisible spacer items between them.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfjsLib = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache-fix')
fs.mkdirSync(CACHE, { recursive: true })

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 25000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*',
                 Referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location
        if (!loc || !loc.startsWith('http')) { res.resume(); return reject(new Error('redirect')) }
        return fetchPdf(loc, retries).then(resolve, reject)
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
      const cs = []
      res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    })
    req.on('error', e => retries > 0 ? fetchPdf(url, retries - 1).then(resolve, reject) : reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function cachedPdf(key, url) {
  const fp = path.join(CACHE, key + '.pdf')
  if (fs.existsSync(fp)) return fs.readFileSync(fp)
  for (const dir of ['pdf-cache', 'pdf-cache-gaps']) {
    const alt = path.join(__dirname, '..', '_tmp', dir)
    if (fs.existsSync(alt)) {
      for (const f of fs.readdirSync(alt)) {
        if (f.includes(key) || f === key + '.pdf') return fs.readFileSync(path.join(alt, f))
      }
    }
  }
  console.log('  📥 Downloading', key)
  const buf = await fetchPdf(url)
  fs.writeFileSync(fp, buf)
  return buf
}

const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s

// Extract all positioned text items from PDF
async function extractAllItems(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const allItems = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    for (const item of content.items) {
      allItems.push({
        x: Math.round(item.transform[4]),
        y: Math.round(item.transform[5]),
        page: p,
        str: item.str,
      })
    }
  }
  allItems.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)
  return allItems
}

// Group items into visual rows (same y ±3px)
function groupIntoRows(items) {
  const rows = []
  let currentY = null, currentRow = []
  for (const item of items) {
    if (currentY === null || Math.abs(item.y - currentY) > 3) {
      if (currentRow.length) rows.push(currentRow)
      currentRow = [item]; currentY = item.y
    } else { currentRow.push(item) }
  }
  if (currentRow.length) rows.push(currentRow)
  return rows
}

// Parse vocabulary-grid rows: [questionNum, (spacer), optA, (spacer), optB, (spacer), optC, (spacer), optD]
// Returns { number: N, options: {A, B, C, D} } for each row that matches
function parseVocabGrid(rows) {
  const results = {}
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x)
    // Filter to non-empty items
    const nonEmpty = row.filter(r => r.str.trim().length > 0)
    if (nonEmpty.length < 3) continue

    // First non-empty item should be a question number at x < 55
    const first = nonEmpty[0]
    if (first.x > 55) continue
    const num = parseInt(first.str.trim())
    if (isNaN(num) || num < 1 || num > 50) continue

    // Remaining items at x > 60 are options
    const optItems = nonEmpty.filter(r => r.x > 60)
    if (optItems.length < 3) continue

    // Must have significant x-spread (not all cramped together = a stem line)
    const xMin = optItems[0].x
    const xMax = optItems[optItems.length - 1].x
    if (xMax - xMin < 200) continue

    // Each option should be reasonably short (< 50 chars) = vocabulary word/phrase
    if (optItems.some(r => r.str.trim().length > 50)) continue

    const labels = ['A', 'B', 'C', 'D']
    const options = {}
    for (let i = 0; i < Math.min(optItems.length, 4); i++) {
      options[labels[i]] = stripPUA(optItems[i].str)
    }
    results[num] = options
  }
  return results
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

const SESSIONS = [
  { year: '108', code: '108050' }, { year: '109', code: '109050' },
  { year: '110', code: '110050' }, { year: '111', code: '111050' },
  { year: '112', code: '112050' }, { year: '114', code: '114040' },
]

async function main() {
  const file = path.join(__dirname, '..', 'questions-customs.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const qs = data.questions

  const broken = qs.filter(q => q.subject === '英文' && ['A', 'B', 'C', 'D'].some(k => !(q.options[k] || '').trim()))
  console.log('English questions with empty options:', broken.length)

  let fixed = 0
  for (const sess of SESSIONS) {
    const sessQs = broken.filter(q => q.exam_code === sess.code)
    if (sessQs.length === 0) continue

    const url = `${BASE}?t=Q&code=${sess.code}&c=101&s=0201&q=1`
    const cacheKey = `customs_${sess.code}_c101_s0201`
    let buf
    try { buf = await cachedPdf(cacheKey, url) } catch (e) { console.log('  ✗', sess.code, e.message); continue }

    const allItems = await extractAllItems(buf)
    const rows = groupIntoRows(allItems)
    const gridOpts = parseVocabGrid(rows)

    let sessFixed = 0
    for (const q of sessQs) {
      const opts = gridOpts[q.number]
      if (!opts) continue
      let changed = false
      for (const k of ['A', 'B', 'C', 'D']) {
        const newV = (opts[k] || '').trim()
        const oldV = (q.options[k] || '').trim()
        if (newV && (!oldV || newV.length > oldV.length)) {
          q.options[k] = newV
          changed = true
        }
      }
      // For grid questions, the "question" is typically just option A (the stem is in the passage).
      // If question text matches option A, it's correct as-is.
      if (changed) { sessFixed++; fixed++ }
    }
    console.log(`  ✓ ${sess.code}: ${sessFixed}/${sessQs.length} fixed (grid detected: ${Object.keys(gridOpts).length} rows)`)
    await sleep(300)
  }

  data.total = qs.length
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
  console.log(`\nTotal fixed: ${fixed}/${broken.length}`)
}

main().catch(e => { console.error(e); process.exit(1) })
