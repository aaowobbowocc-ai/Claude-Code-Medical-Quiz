#!/usr/bin/env node
/**
 * Fix empty options in doctor1/doctor2 old-format PDFs (100-104 年).
 * Uses pdfjs-dist position-based extraction instead of mupdf column parser.
 *
 * Strategy: for each target question, re-download the PDF, extract all text
 * items with (x,y) positions via pdfjs, find the question anchor (number),
 * then split surrounding text into left/right column by x-coordinate.
 * Left col → A (first), C (second); right col → B (first), D (second).
 *
 * Usage:
 *   node scripts/fix-empty-options.js             # fix all
 *   node scripts/fix-empty-options.js --dry       # dry run, show what would change
 *   node scripts/fix-empty-options.js --debug 103100_102_0105  # show raw pdfjs output
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs   = require('fs')
const path = require('path')
const https = require('https')
const pdfjsLib = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')

const BACKEND = path.resolve(__dirname, '..')
const CACHE   = path.join(BACKEND, '_tmp', 'fix-empty-opts-cache')
const DRY     = process.argv.includes('--dry')
const DEBUG_TARGET = process.argv.find(a => a.startsWith('--debug '))?.slice(8)
  || (process.argv.indexOf('--debug') !== -1 ? process.argv[process.argv.indexOf('--debug') + 1] : null)

if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true })

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'

// ─── Targets ──────────────────────────────────────────────────────────────────
// Each entry defines: one PDF to download, a list of question numbers with empty
// options, and which JSON file to patch.
const TARGETS = [
  {
    key: '100030_101_0101', code: '100030', c: '101', s: '0101',
    subject: '醫學(一)', jsonFile: 'questions.json',
    fixes: [{ num: 73, empty: ['D'] }, { num: 78, empty: ['B'] }],
  },
  {
    key: '100030_101_0102', code: '100030', c: '101', s: '0102',
    subject: '醫學(二)', jsonFile: 'questions.json',
    fixes: [{ num: 41, empty: ['B'] }],
  },
  {
    key: '103100_102_0104', code: '103100', c: '102', s: '0104',
    subject: '醫學(四)', jsonFile: 'questions-doctor2.json',
    fixes: [{ num: 16, empty: ['C'] }, { num: 26, empty: ['C'] }, { num: 63, empty: ['C'] }],
  },
  {
    key: '103100_102_0105', code: '103100', c: '102', s: '0105',
    subject: '醫學(五)', jsonFile: 'questions-doctor2.json',
    fixes: [
      { num: 3,  empty: ['A','C'] }, { num: 16, empty: ['A','C'] },
      { num: 56, empty: ['C'] },     { num: 63, empty: ['A'] },
      { num: 71, empty: ['A','C'] }, { num: 75, empty: ['A','C'] },
      { num: 76, empty: ['A','D'] },
    ],
  },
  {
    key: '103100_102_0106', code: '103100', c: '102', s: '0106',
    subject: '醫學(六)', jsonFile: 'questions-doctor2.json',
    fixes: [{ num: 2, empty: ['A','C'] }, { num: 26, empty: ['A','C'] }, { num: 28, empty: ['A','C'] }],
  },
  {
    key: '104030_102_0103', code: '104030', c: '102', s: '0103',
    subject: '醫學(三)', jsonFile: 'questions-doctor2.json',
    fixes: [{ num: 10, empty: ['A'] }, { num: 19, empty: ['A'] }, { num: 45, empty: ['A'] }, { num: 53, empty: ['A'] }],
  },
  {
    key: '100140_102_0105', code: '100140', c: '102', s: '0105',
    subject: '醫學(五)', jsonFile: 'questions-doctor2.json',
    fixes: [{ num: 39, empty: ['B'] }],
  },
  {
    key: '101110_102_0106', code: '101110', c: '102', s: '0106',
    subject: '醫學(六)', jsonFile: 'questions-doctor2.json',
    fixes: [{ num: 33, empty: ['D'] }],
  },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 30000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*',
                 Referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location
        if (!loc || !loc.startsWith('http')) { res.resume(); return reject(new Error('302 redirect')) }
        return fetchPdf(loc, retries).then(resolve, reject)
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
      const cs = []; res.on('data', c => cs.push(c)); res.on('end', () => resolve(Buffer.concat(cs)))
    })
    req.on('error', e => retries > 0
      ? setTimeout(() => fetchPdf(url, retries-1).then(resolve, reject), 1000)
      : reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

// Extract all text items with positions from all pages using pdfjs
// y = transform[5] = distance from bottom of page (higher = higher on page)
async function extractItems(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const items = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    for (const it of content.items) {
      const s = it.str.replace(/[- ]/g, '').trim()
      if (!s) continue  // skip empty / PUA / bullet markers
      items.push({
        x: Math.round(it.transform[4]),
        y: Math.round(it.transform[5]),  // from-bottom: higher = higher on page
        str: s, page: p,
      })
    }
  }
  // Sort: top-to-bottom = descending y, then left-to-right = ascending x
  items.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)
  return items
}

// Group items into logical rows (same y ±3 within same page)
// Items are already sorted top-to-bottom (descending y)
function groupRows(items) {
  const rows = []
  for (const it of items) {
    const last = rows[rows.length - 1]
    if (last && last.page === it.page && Math.abs(last.y - it.y) <= 3) {
      last.items.push(it)
    } else {
      rows.push({ y: it.y, page: it.page, items: [it] })
    }
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x)
  return rows
}

// Join all text items in a row
const rowText = r => r.items.map(i => i.str).join(' ').trim()

// Find question number anchors: rows where the first item is a standalone number
// in the expected range, at a small x value
function findAnchors(rows) {
  const anchors = []
  const seen = new Set()
  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri]
    const first = r.items[0]
    if (!first) continue
    if (first.x > 70) continue  // question numbers at left margin
    const m = first.str.match(/^(\d{1,3})[.、．]?$/)
    if (!m) continue
    const n = +m[1]
    if (n < 1 || n > 100 || seen.has(n)) continue
    // Reject header rows: second item on same row starts with a digit (e.g. "10" "4 年...")
    if (r.items.length >= 2 && /^\d/.test(r.items[1].str)) continue
    // Reject if any item on this row looks like header text
    const fullRow = r.items.map(i => i.str).join('')
    if (/年第|代號|頁次|考試|類科|科目|等別/.test(fullRow)) continue
    seen.add(n)
    anchors.push({ num: n, y: r.y, page: r.page, rowIdx: ri })
  }
  return anchors
}

// Determine page width from items (max x + buffer)
function estimatePageWidth(items) {
  const maxX = Math.max(...items.map(i => i.x))
  return maxX + 50
}

// For a block of rows belonging to one question, extract options A,B,C,D
// Uses x-coordinate: items with x < midX are left column (A, C in top-to-bottom order)
//                    items with x >= midX are right column (B, D in top-to-bottom order)
// Works at item level (not row level) to handle 1-row 4-option layout correctly.
function extractOptions(blockRows, midX) {
  // Flatten all items in the block, excluding question-anchor x values (< 78)
  const allItems = []
  for (const r of blockRows) {
    for (const it of r.items) {
      if (it.x < 78) continue  // skip question numbers and leading bullet markers
      allItems.push(it)
    }
  }

  // Separate into left/right columns
  const leftItems  = allItems.filter(i => i.x < midX)
  const rightItems = allItems.filter(i => i.x >= midX)

  // Sort each column: top-to-bottom (descending y), then left-to-right (ascending x)
  leftItems.sort((a, b)  => b.y - a.y || a.x - b.x)
  rightItems.sort((a, b) => b.y - a.y || a.x - b.x)

  // Options appear at the END of the question block (after the question text).
  // Question text is also in the left column, so we take the LAST 2 items from each.
  const leftOpts  = leftItems.filter(i => i.str).slice(-2).map(i => i.str)
  const rightOpts = rightItems.filter(i => i.str).slice(-2).map(i => i.str)

  return {
    A: leftOpts[0]  || '',
    B: rightOpts[0] || '',
    C: leftOpts[1]  || '',
    D: rightOpts[1] || '',
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function processTarget(t) {
  const url = `${BASE}?t=Q&code=${t.code}&c=${t.c}&s=${t.s}&q=1`
  const cacheFile = path.join(CACHE, `${t.key}.pdf`)

  let buf
  if (fs.existsSync(cacheFile)) {
    buf = fs.readFileSync(cacheFile)
    console.log(`  [cache] ${t.key}`)
  } else {
    console.log(`  [fetch] ${url}`)
    try { buf = await fetchPdf(url) } catch (e) { console.error(`  SKIP ${t.key}: ${e.message}`); return null }
    fs.writeFileSync(cacheFile, buf)
  }

  const items = await extractItems(buf)
  const rows  = groupRows(items)
  const pageW = estimatePageWidth(items)
  const midX  = Math.round(pageW / 2)
  const anchors = findAnchors(rows)

  if (DEBUG_TARGET === t.key) {
    console.log(`\n=== DEBUG ${t.key} ===`)
    console.log(`pageW=${pageW} midX=${midX}`)
    console.log(`anchors: ${anchors.map(a=>`${a.num}(y=${a.y})`).join(', ')}`)
    console.log('\n--- First 80 rows ---')
    for (const r of rows.slice(0, 80)) {
      const txt = rowText(r)
      if (txt) console.log(`  y=${r.y} x=${r.items[0]?.x} | ${txt.slice(0,80)}`)
    }
    return null
  }

  const results = {}  // num → { A, B, C, D }

  for (const fix of t.fixes) {
    const anchor = anchors.find(a => a.num === fix.num)
    if (!anchor) { console.warn(`  WARN: Q${fix.num} anchor not found in ${t.key}`); continue }

    const nextAnchor = anchors.find(a => a.num > fix.num)
    const startIdx = anchor.rowIdx
    const endIdx   = nextAnchor ? nextAnchor.rowIdx : rows.length

    const blockRows = rows.slice(startIdx, endIdx)
    const opts = extractOptions(blockRows, midX)
    results[fix.num] = { opts, empty: fix.empty }

    console.log(`  Q${fix.num} extracted: A='${opts.A.slice(0,30)}' B='${opts.B.slice(0,30)}' C='${opts.C.slice(0,30)}' D='${opts.D.slice(0,30)}'`)
  }

  return { jsonFile: t.jsonFile, subject: t.subject, code: t.code, results }
}

async function main() {
  console.log(`DRY=${DRY}`)

  // Load JSON files once
  const jsonFiles = {}
  const jsonPaths = {}
  for (const t of TARGETS) {
    if (!jsonFiles[t.jsonFile]) {
      jsonPaths[t.jsonFile] = path.join(BACKEND, t.jsonFile)
      jsonFiles[t.jsonFile] = JSON.parse(fs.readFileSync(jsonPaths[t.jsonFile], 'utf8'))
    }
  }

  let totalFixed = 0

  for (const t of TARGETS) {
    if (DEBUG_TARGET && DEBUG_TARGET !== t.key) continue
    console.log(`\n[${t.key}] ${t.subject} (${t.fixes.length} questions)`)
    const result = await processTarget(t)
    if (!result) continue

    const data = jsonFiles[result.jsonFile]
    const qs   = data.questions

    for (const [numStr, { opts, empty }] of Object.entries(result.results)) {
      const num = +numStr
      const q = qs.find(q => q.exam_code === t.code && q.subject === t.subject && q.number === num)
      if (!q) { console.warn(`  WARN: Q${num} not found in ${result.jsonFile}`); continue }

      // Validate: extracted options must cover all 4 slots and look like real options
      const isValidOption = s => {
        if (!s || s.trim().length < 2) return false
        const t = s.trim()
        if (/^[，。；、）\)（\(]+$/.test(t)) return false  // pure punctuation
        if (/^[-）（]/.test(t)) return false  // starts with hyphen or paren = fragment
        if (/[（(]$/.test(t)) return false  // ends with open paren = fragment
        if (/^\w$/.test(t)) return false  // single letter
        return true
      }
      const invalidOpts = Object.entries(opts).filter(([, v]) => !isValidOption(v))
      if (invalidOpts.length) {
        console.warn(`  SKIP: Q${num} has invalid extracted opts: ${invalidOpts.map(([k,v])=>k+'='+JSON.stringify(v)).join(', ')}`)
        continue
      }
      // Skip if any two options are identical (indicates extraction confusion)
      const vals = Object.values(opts)
      const hasDup = vals.some((v, i) => vals.findIndex(w => w === v) !== i)
      if (hasDup) {
        console.warn(`  SKIP: Q${num} has duplicate options`)
        continue
      }
      const missingStillEmpty = empty.filter(k => !opts[k])
      if (missingStillEmpty.length) {
        console.warn(`  WARN: Q${num} still empty after extraction: ${missingStillEmpty.join(',')}`)
        continue
      }
      // Also clean extra whitespace in option text
      for (const k of Object.keys(opts)) opts[k] = opts[k].trim().replace(/\s{2,}/g, ' ')

      if (DRY) {
        // Show what would be written for ALL 4 options (not just empty ones)
        for (const [k, v] of Object.entries(opts)) {
          const marker = empty.includes(k) ? '[FIX]' : (q.options[k] !== v ? '[CHG]' : '[same]')
          console.log(`  [DRY] Q${num} ${k} ${marker} = '${v.slice(0,50)}'`)
        }
      } else {
        // Replace ALL 4 options with the correctly extracted values
        for (const [k, v] of Object.entries(opts)) q.options[k] = v
        if (q.incomplete) delete q.incomplete
        totalFixed++
      }
    }
  }

  if (!DRY) {
    for (const [file, data] of Object.entries(jsonFiles)) {
      fs.writeFileSync(jsonPaths[file], JSON.stringify(data, null, 2))
      console.log(`\nWrote ${file}`)
    }
    console.log(`\nTotal options fixed: ${totalFixed}`)
  } else {
    console.log('\n[DRY RUN - no changes written]')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
