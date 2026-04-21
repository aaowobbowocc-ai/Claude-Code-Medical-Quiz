#!/usr/bin/env node
/**
 * fix-truncated-mupdf.js — 用 mupdf column-aware parser 修復所有截斷/不完整的題目
 *
 * 偵測標準：
 * 1. 選項部分為空（有些有文字、有些空字串）
 * 2. 題目文字中的序號列表被截斷
 * 3. 選項文字首字遺失
 *
 * 排除：全 4 選項為空（圖片題）
 *
 * Usage:
 *   node scripts/fix-truncated-mupdf.js --dry          # 預覽不寫入
 *   node scripts/fix-truncated-mupdf.js                # 執行修復
 *   node scripts/fix-truncated-mupdf.js --exam medlab  # 只修某考試
 */

const fs = require('fs')
const path = require('path')
const https = require('https')

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const DRY_RUN = process.argv.includes('--dry')
const examFilter = process.argv.includes('--exam') ? process.argv[process.argv.indexOf('--exam') + 1] : null
const BACKEND = path.resolve(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache-fix')
fs.mkdirSync(PDF_CACHE, { recursive: true })

const BASE_URL = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'

// ─── Exam definitions: file → { classCode, papers[], sessions[] } ───
// Combines all known mappings from scrape-moex-old.js, scrape-tcm-vet.js,
// scrape-nursing-nutrition-sw-old.js, scrape-gaps-2026-04.js

const EXAM_DEFS = {
  'questions.json': {
    prefix: 'doctor1', classCode: '301',
    papers: [
      { s: '11', subject: '醫學(一)' }, { s: '22', subject: '醫學(二)' },
    ],
  },
  'questions-doctor2.json': {
    prefix: 'doctor2', classCode: '302',
    papers: [
      { s: '11', subject: '醫學(三)' }, { s: '22', subject: '醫學(四)' },
      { s: '33', subject: '醫學(五)' }, { s: '44', subject: '醫學(六)' },
    ],
  },
  'questions-dental1.json': {
    prefix: 'dental1', classCode: '303',
    papers: [
      { s: '11', subject: '卷一' }, { s: '22', subject: '卷二' },
    ],
  },
  'questions-dental2.json': {
    prefix: 'dental2', classCode: '304',
    papers: [
      { s: '33', subject: '卷一' }, { s: '44', subject: '卷二' },
      { s: '55', subject: '卷三' }, { s: '66', subject: '卷四' },
    ],
  },
  'questions-pharma1.json': {
    prefix: 'pharma1', classCode: '305',
    papers: [
      { s: '33', subject: '卷一' }, { s: '44', subject: '卷二' },
      { s: '55', subject: '卷三' },
    ],
  },
  'questions-pharma2.json': {
    prefix: 'pharma2', classCode: '306',
    papers: [
      { s: '44', subject: '調劑與臨床' }, { s: '55', subject: '藥物治療' },
      { s: '66', subject: '法規' },
    ],
  },
  'questions-medlab.json': {
    prefix: 'medlab', classCode: '308',
    // Old sessions (106-109) all use 2-digit codes; broken Qs are all in this range
    papers: [
      { s: '11', subject: '臨床生理學與病理學' }, { s: '22', subject: '臨床血液學與血庫學' },
      { s: '33', subject: '醫學分子檢驗學與臨床鏡檢學' }, { s: '44', subject: '微生物學與臨床微生物學' },
      { s: '55', subject: '生物化學與臨床生化學' }, { s: '66', subject: '臨床血清免疫學與臨床病毒學' },
    ],
  },
  'questions-pt.json': {
    prefix: 'pt', classCode: '311',
    papers: [
      { s: '11', subject: '神經疾病物理治療學' }, { s: '22', subject: '骨科疾病物理治療學' },
      { s: '33', subject: '心肺疾病與小兒疾病物理治療學' }, { s: '44', subject: '物理治療基礎學' },
      { s: '55', subject: '物理治療學概論' }, { s: '66', subject: '物理治療技術學' },
    ],
  },
  'questions-ot.json': {
    prefix: 'ot', classCode: '312',
    papers: [
      { s: '11', subject: '解剖學與生理學' }, { s: '22', subject: '職能治療學概論' },
      { s: '33', subject: '生理疾病職能治療學' }, { s: '44', subject: '心理疾病職能治療學' },
      { s: '55', subject: '小兒疾病職能治療學' }, { s: '66', subject: '職能治療技術學' },
    ],
  },
  'questions-radiology.json': {
    prefix: 'radiology', classCode: '309',
    papers: [
      { s: '11', subject: '基礎醫學（包括解剖學、生理學與病理學）' },
      { s: '22', subject: '醫學物理學與輻射安全' },
      { s: '33', subject: '放射線器材學（包括磁振學與超音波學）' },
      { s: '44', subject: '放射線診斷原理與技術學' },
      { s: '55', subject: '放射線治療原理與技術學' },
      { s: '66', subject: '核子醫學診療原理與技術學' },
    ],
  },
  'questions-nursing.json': {
    prefix: 'nursing',
    // Nursing class codes changed over time
    papersByClassCode: {
      '106': [ // c=106, years 106-109
        { s: '0501', subject: '基礎醫學' }, { s: '0502', subject: '基本護理學與護理行政' },
        { s: '0503', subject: '內外科護理學' }, { s: '0504', subject: '產兒科護理學' },
        { s: '0505', subject: '精神科與社區衛生護理學' },
      ],
      '104': [ // c=104 for some sessions (110, 111, 113)
        { s: '0301', subject: '基礎醫學' }, { s: '0302', subject: '基本護理學與護理行政' },
        { s: '0303', subject: '內外科護理學' }, { s: '0304', subject: '產兒科護理學' },
        { s: '0305', subject: '精神科與社區衛生護理學' },
      ],
      '102': [ // c=102 for 112030
        { s: '0201', subject: '基礎醫學' }, { s: '0202', subject: '基本護理學與護理行政' },
        { s: '0203', subject: '內外科護理學' }, { s: '0204', subject: '產兒科護理學' },
        { s: '0205', subject: '精神科與社區衛生護理學' },
      ],
      '101': [ // c=101 for 114+
        { s: '0101', subject: '基礎醫學' }, { s: '0102', subject: '基本護理學與護理行政' },
        { s: '0103', subject: '內外科護理學' }, { s: '0104', subject: '產兒科護理學' },
        { s: '0105', subject: '精神科與社區衛生護理學' },
      ],
    },
    classCodeBySession: {
      '106030': '106', '106110': '106', '107030': '106', '107110': '106',
      '108020': '106', '108110': '106', '109030': '106', '109110': '106',
      '110030': '104', '111030': '104', '111110': '104',
      '112030': '102', '113030': '104', '114030': '101', '115030': '101',
    },
    papers: [], // use papersByClassCode
  },
  'questions-nutrition.json': {
    prefix: 'nutrition',
    papersByClassCode: {
      '103': [
        { s: '0201', subject: '生理學與生物化學' }, { s: '0202', subject: '營養學' },
        { s: '0203', subject: '膳食療養學' }, { s: '0204', subject: '團體膳食設計與管理' },
        { s: '0205', subject: '公共衛生營養學' }, { s: '0206', subject: '食品衛生與安全' },
      ],
      '102': [
        { s: '0101', subject: '生理學與生物化學' }, { s: '0102', subject: '營養學' },
        { s: '0103', subject: '膳食療養學' }, { s: '0104', subject: '團體膳食設計與管理' },
        { s: '0105', subject: '公共衛生營養學' }, { s: '0106', subject: '食品衛生與安全' },
      ],
    },
    classCodeBySession: {
      '106030': '103', '106110': '103', '107030': '103', '107110': '103',
      '108020': '103', '109030': '103', '109110': '103',
      '112030': '102', '114030': '102', '115030': '102',
    },
    papers: [],
  },
  'questions-social-worker.json': {
    prefix: 'social-worker',
    papersByClassCode: {
      '107': [
        { s: '0601', subject: '社會工作' }, { s: '0602', subject: '社會工作直接服務' },
        { s: '0603', subject: '社會工作管理' },
      ],
    },
    classCodeBySession: {
      '106030': '107', '106110': '107', '107030': '107', '108110': '107',
      '109030': '107', '113030': '107', '115030': '107',
    },
    papers: [],
  },
  'questions-tcm1.json': {
    prefix: 'tcm1', classCode: '101',
    // For 106-109 using c=101
    papersByClassCode: {
      '101': [
        { s: '0101', subject: '中醫基礎醫學(一)' }, { s: '0102', subject: '中醫基礎醫學(二)' },
      ],
      '317': [
        { s: '0101', subject: '中醫基礎醫學(一)' }, { s: '0102', subject: '中醫基礎醫學(二)' },
      ],
    },
    classCodeBySession: {
      '106030': '101', '106110': '101', '107030': '101', '107110': '101',
      '108020': '101', '108110': '101',
      '112020': '317', '112090': '317', '113020': '317', '113090': '317',
      '114020': '317', '115020': '317',
    },
    papers: [
      { s: '0101', subject: '中醫基礎醫學(一)' }, { s: '0102', subject: '中醫基礎醫學(二)' },
    ],
  },
  'questions-tcm2.json': {
    prefix: 'tcm2', classCode: '102',
    papersByClassCode: {
      '102': [
        { s: '0103', subject: '中醫臨床醫學(一)' }, { s: '0104', subject: '中醫臨床醫學(二)' },
        { s: '0105', subject: '中醫臨床醫學(三)' }, { s: '0106', subject: '中醫臨床醫學(四)' },
      ],
      '318': [
        { s: '0103', subject: '中醫臨床醫學(一)' }, { s: '0104', subject: '中醫臨床醫學(二)' },
        { s: '0105', subject: '中醫臨床醫學(三)' }, { s: '0106', subject: '中醫臨床醫學(四)' },
      ],
    },
    classCodeBySession: {
      '106030': '102', '106110': '102', '107030': '102', '107110': '102',
      '108020': '102', '108110': '102', '109030': '102', '109110': '102',
      '110030': '102',
      '112020': '318', '112090': '318', '113020': '318', '113090': '318',
      '114020': '318', '115020': '318',
    },
    papers: [
      { s: '0103', subject: '中醫臨床醫學(一)' }, { s: '0104', subject: '中醫臨床醫學(二)' },
      { s: '0105', subject: '中醫臨床醫學(三)' }, { s: '0106', subject: '中醫臨床醫學(四)' },
    ],
  },
  'questions-vet.json': {
    prefix: 'vet', classCode: '309',
    // vet shares classCode 309 with radiology in some sessions!
    papersByClassCode: {
      '309': [
        { s: '11', subject: '獸醫學(一)' }, { s: '22', subject: '獸醫學(二)' },
        { s: '33', subject: '獸醫學(三)' }, { s: '44', subject: '獸醫學(四)' },
        { s: '55', subject: '獸醫學(五)' }, { s: '66', subject: '獸醫學(六)' },
      ],
      '319': [
        { s: '0101', subject: '獸醫學(一)' }, { s: '0102', subject: '獸醫學(二)' },
        { s: '0103', subject: '獸醫學(三)' }, { s: '0104', subject: '獸醫學(四)' },
        { s: '0105', subject: '獸醫學(五)' }, { s: '0106', subject: '獸醫學(六)' },
      ],
    },
    classCodeBySession: {
      '106100': '309', '107020': '309', '107100': '309',
      '108030': '309', '109020': '309',
      '111100': '309',
      '112020': '319', '113020': '319', '114020': '319', '115020': '319',
    },
    papers: [
      { s: '11', subject: '獸醫學(一)' }, { s: '22', subject: '獸醫學(二)' },
      { s: '33', subject: '獸醫學(三)' }, { s: '44', subject: '獸醫學(四)' },
      { s: '55', subject: '獸醫學(五)' }, { s: '66', subject: '獸醫學(六)' },
    ],
  },
  'questions-customs.json': {
    prefix: 'customs',
    urlClassCode: '101', // class code is always 101, but subject codes vary by year
    papersByClassCode: {
      'y108': [
        { s: '0307', subject: '法學知識' }, { s: '0201', subject: '英文' }, { s: '0101', subject: '國文（測驗）' },
      ],
      'y109': [
        { s: '0308', subject: '法學知識' }, { s: '0201', subject: '英文' }, { s: '0101', subject: '國文（測驗）' },
      ],
      'y110': [
        { s: '0308', subject: '法學知識' }, { s: '0201', subject: '英文' }, { s: '0101', subject: '國文（測驗）' },
      ],
      'y111': [
        { s: '0310', subject: '法學知識' }, { s: '0201', subject: '英文' }, { s: '0101', subject: '國文（測驗）' },
      ],
      'y112': [
        { s: '0308', subject: '法學知識' }, { s: '0201', subject: '英文' }, { s: '0101', subject: '國文（測驗）' },
      ],
      'y113': [
        { s: '0306', subject: '法學知識' }, { s: '0201', subject: '英文' }, { s: '0101', subject: '國文（測驗）' },
      ],
      'y114': [
        { s: '0305', subject: '法學知識' }, { s: '0201', subject: '英文' }, { s: '0101', subject: '國文（測驗）' },
      ],
    },
    classCodeBySession: {
      '108050': 'y108', '109050': 'y109', '110050': 'y110',
      '111050': 'y111', '112050': 'y112', '113040': 'y113', '114040': 'y114',
    },
    papers: [],
  },
  'questions-police.json': {
    prefix: 'police',
    urlClassCode: '301', // class code is always 301
    papersByClassCode: {
      'y108': [
        { s: '0301', subject: '行政學' },
      ],
      'y109': [
        { s: '0301', subject: '行政學' }, { s: '0402', subject: '行政法' },
      ],
      'y110': [
        { s: '0301', subject: '行政學' },
      ],
      'y111': [
        { s: '0301', subject: '行政學' },
      ],
      'y112': [
        { s: '0301', subject: '行政學' },
      ],
      'y113': [
        { s: '0301', subject: '行政學' }, { s: '0403', subject: '行政法' },
      ],
      'y114': [
        { s: '0304', subject: '行政學' }, { s: '0403', subject: '行政法' },
      ],
    },
    classCodeBySession: {
      '108070': 'y108', '109070': 'y109', '110070': 'y110',
      '111070': 'y111', '112070': 'y112', '113060': 'y113', '114060': 'y114',
    },
    papers: [],
  },
}

// These exams still need separate handling
const SKIP_FILES = [
  'questions-judicial.json', 'questions-lawyer1.json',
  'questions-civil-senior.json',
]

// ─── HTTP helpers ───

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 20000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*',
                 Referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location
        if (!loc || !loc.startsWith('http')) { res.resume(); return reject(new Error('redirect')) }
        return fetchPdf(loc, retries).then(resolve, reject)
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)) }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    })
    req.on('error', e => retries > 0 ? fetchPdf(url, retries - 1).then(resolve, reject) : reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function cachedPdf(cacheKey, url) {
  const fp = path.join(PDF_CACHE, cacheKey + '.pdf')
  if (fs.existsSync(fp)) return fs.readFileSync(fp)
  // Also check other cache dirs
  for (const dir of ['pdf-cache', 'pdf-cache-gaps']) {
    const alt = path.join(BACKEND, '_tmp', dir)
    if (fs.existsSync(alt)) {
      const files = fs.readdirSync(alt)
      for (const f of files) {
        if (f.includes(cacheKey) || f === cacheKey + '.pdf') {
          return fs.readFileSync(path.join(alt, f))
        }
      }
    }
  }
  console.log(`    📥 下載 ${cacheKey}`)
  const buf = await fetchPdf(url)
  if (buf.length < 5000) throw new Error('PDF too small')
  fs.writeFileSync(fp, buf)
  return buf
}

// ─── mupdf raw line extractor ───

function extractPageLines(pg) {
  const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
  const spans = []
  for (const b of parsed.blocks || []) {
    if (b.type !== 'text') continue
    for (const ln of (b.lines || [])) {
      const t = ln.text || ''
      if (!t.trim()) continue
      spans.push({ y: Math.round(ln.bbox.y * 10) / 10, x: Math.round(ln.bbox.x * 10) / 10, text: t })
    }
  }
  return spans
}

function joinSpans(texts) {
  let out = texts[0] || ''
  for (let i = 1; i < texts.length; i++) {
    const next = texts[i]
    let overlap = 0
    const max = Math.min(out.length, next.length, 8)
    for (let k = max; k > 0; k--) {
      if (out.slice(-k) === next.slice(0, k)) { overlap = k; break }
    }
    out += next.slice(overlap)
  }
  return out
}

// Group spans by y-coordinate into rows
function groupRows(spans) {
  const rows = []
  for (const s of spans.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const last = rows[rows.length - 1]
    if (last && Math.abs(last.y - s.y) <= 3) last.spans.push(s)
    else rows.push({ y: s.y, spans: [s] })
  }
  return rows
}

// Detect if a row has 4 short items spread across the page (positional options)
function isPositionalOptionRow(row) {
  if (row.spans.length < 3) return false
  const xs = row.spans.map(s => s.x).sort((a, b) => a - b)
  // At least 3 spans spread across >200pt width
  if (xs[xs.length - 1] - xs[0] < 200) return false
  // Each span is relatively short (option text)
  const allShort = row.spans.every(s => s.text.trim().length < 60)
  return allShort
}

// Detect if a row has 2 option items (left + right, for 2-per-line option layout)
// These rows have 2+ spans with a clear gap (>100pt between clusters)
function is2OptionRow(row) {
  const nonEmpty = row.spans.filter(s => s.text.trim().length > 0)
  if (nonEmpty.length < 2) return false
  const sorted = nonEmpty.sort((a, b) => a.x - b.x)
  // Find the biggest gap between consecutive spans
  let maxGap = 0
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].x - (sorted[i-1].x + sorted[i-1].text.length * 5) // rough char width
    maxGap = Math.max(maxGap, sorted[i].x - sorted[i-1].x)
  }
  // Need a clear gap between two clusters (at least 100pt) and each cluster is short
  if (maxGap < 100) return false
  // Split into left/right clusters
  const mid = (sorted[0].x + sorted[sorted.length-1].x) / 2
  const left = sorted.filter(s => s.x < mid)
  const right = sorted.filter(s => s.x >= mid)
  if (left.length === 0 || right.length === 0) return false
  const leftText = joinSpans(left.map(s => s.text)).trim()
  const rightText = joinSpans(right.map(s => s.text)).trim()
  // Both should be relatively short (option text, not question text)
  return leftText.length < 80 && rightText.length < 80 && leftText.length > 0 && rightText.length > 0
}

function get2OptionTexts(row) {
  const nonEmpty = row.spans.filter(s => s.text.trim().length > 0)
  const sorted = nonEmpty.sort((a, b) => a.x - b.x)
  const mid = (sorted[0].x + sorted[sorted.length-1].x) / 2
  const left = sorted.filter(s => s.x < mid)
  const right = sorted.filter(s => s.x >= mid)
  return {
    left: joinSpans(left.map(s => s.text)).trim(),
    right: joinSpans(right.map(s => s.text)).trim(),
  }
}

// Convert raw page spans into flat text lines, handling 2-column layout and positional options
function pageToStructured(pg) {
  const spans = extractPageLines(pg)
  const rows = groupRows(spans)
  const result = [] // each: { type: 'text' | 'options', text?, options? }

  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri]
    if (isPositionalOptionRow(row)) {
      // Sort by x, assign A/B/C/D positionally
      const sorted = row.spans.sort((a, b) => a.x - b.x)
      const opts = {}
      const labels = ['A', 'B', 'C', 'D']
      for (let i = 0; i < Math.min(sorted.length, 4); i++) {
        opts[labels[i]] = sorted[i].text.trim()
      }
      result.push({ type: 'options', options: opts })
    } else if (is2OptionRow(row) && ri + 1 < rows.length && is2OptionRow(rows[ri + 1])) {
      // Two consecutive 2-option rows → merge into A/B/C/D
      const first = get2OptionTexts(row)
      const second = get2OptionTexts(rows[ri + 1])
      result.push({ type: 'options', options: {
        A: first.left, B: first.right,
        C: second.left, D: second.right,
      }})
      ri++ // skip the next row (already consumed)
    } else {
      // Check for 2-column text: if we have 2 clusters of spans with gap > 150pt
      const sorted = row.spans.sort((a, b) => a.x - b.x)
      const isSingleColumn = sorted.some(s => s.x > 200 && s.x < 320)
      if (!isSingleColumn && sorted.length >= 2) {
        const mid = 300
        const left = sorted.filter(s => s.x < mid)
        const right = sorted.filter(s => s.x >= mid)
        if (left.length > 0 && right.length > 0) {
          // Two separate text columns — they'll be from different questions
          result.push({ type: 'text', text: joinSpans(left.map(s => s.text)), x: left[0].x })
          result.push({ type: 'text-right', text: joinSpans(right.map(s => s.text)), x: right[0].x })
          continue
        }
      }
      result.push({ type: 'text', text: joinSpans(sorted.map(s => s.text)), x: sorted[0].x })
    }
  }
  return result
}

// Build full structured data from PDF buffer
async function fullPdfStructured(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const allItems = []
  for (let i = 0; i < doc.countPages(); i++) {
    allItems.push(...pageToStructured(doc.loadPage(i)))
  }
  return allItems
}

// Also keep the simple text-based version for labeled-option PDFs
async function fullPdfText(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) {
    const spans = extractPageLines(doc.loadPage(i))
    const rows = groupRows(spans)
    // Simple left→right column join
    const isSingleColumn = spans.some(s => s.x > 200 && s.x < 320)
    const mid = 300
    const left = isSingleColumn ? spans : spans.filter(s => s.x < mid)
    const right = isSingleColumn ? [] : spans.filter(s => s.x >= mid)
    function groupAndJoin(arr) {
      const g = groupRows(arr.sort((a, b) => a.y - b.y || a.x - b.x))
      return g.map(r => joinSpans(r.spans.sort((a, b) => a.x - b.x).map(s => s.text)))
    }
    txt += [...groupAndJoin(left), ...groupAndJoin(right)].join('\n') + '\n'
  }
  return txt
}

// ─── Question extractor (labeled options) ───

function extractQA_labeled(text, N) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  let i = 0
  const startRe = new RegExp(`^${N}[.．、]\\s*(.*)$`)
  const nextRe = new RegExp(`^${N + 1}[.．、]\\s*`)
  while (i < lines.length && !startRe.test(lines[i])) i++
  if (i >= lines.length) return null
  const buf = []
  let stem = lines[i].replace(startRe, '$1')
  if (stem) buf.push(stem)
  i++
  const opts = { A: '', B: '', C: '', D: '' }
  let curOpt = null
  for (; i < lines.length; i++) {
    const ln = lines[i]
    if (nextRe.test(ln)) break
    if (/^(代\s*號|類\s*科|科\s*目|考試|頁次|等\s*別|座號|※)/.test(ln)) continue
    const optMatch = ln.match(/^\(?([A-D])\)?[.．、)）]\s*(.*)$/)
    if (optMatch) { curOpt = optMatch[1]; opts[curOpt] = optMatch[2]; continue }
    if (/^[A-D]$/.test(ln) && curOpt !== ln) { curOpt = ln; opts[curOpt] = ''; continue }
    if (curOpt) opts[curOpt] += (opts[curOpt] ? ' ' : '') + ln
    else buf.push(ln)
  }
  const stemFull = buf.join(' ').trim()
  const clean = s => s.replace(/[\uE000-\uF8FF]/g, '').trim()
  return {
    question: clean(stemFull),
    options: { A: clean(opts.A), B: clean(opts.B), C: clean(opts.C), D: clean(opts.D) },
  }
}

// ─── Question extractor (positional options) ───

function extractQA_positional(items, N) {
  // items = array of { type, text, options, x }
  // Match "N." or "N、" or just "N" followed by Chinese text (no separator in some PDFs)
  const startRe = new RegExp(`^${N}[.．、\\s]?\\s*([\\u4e00-\\u9fffA-Za-z(（].*)$`)
  const nextRe = new RegExp(`^${N + 1}[.．、\\s]?\\s*[\\u4e00-\\u9fffA-Za-z(（]`)

  // Find the start of question N in left-column text items
  let startIdx = -1
  for (let i = 0; i < items.length; i++) {
    if (items[i].type === 'text' && startRe.test(items[i].text.trim())) {
      startIdx = i
      break
    }
  }
  if (startIdx < 0) return null

  const stemParts = []
  let stem = items[startIdx].text.trim().replace(startRe, '$1')
  if (stem) stemParts.push(stem)

  let lastOpts = null
  const textAfterStem = [] // collect all text items for fallback option detection
  for (let i = startIdx + 1; i < items.length; i++) {
    const item = items[i]
    if (item.type === 'text' && nextRe.test(item.text.trim())) break
    if (item.type === 'text-right' && nextRe.test(item.text.trim())) break
    if (item.type === 'text' && /^(代\s*號|類\s*科|科\s*目|考試|頁次|等\s*別|座號|※)/.test(item.text.trim())) continue

    if (item.type === 'options') {
      lastOpts = item.options
      break // Options found, stop
    }
    // Regular text line (continuation of question stem or multi-line question)
    if (item.type === 'text') {
      stemParts.push(item.text.trim())
      textAfterStem.push(item.text.trim())
    }
  }

  // Fallback: if no structured options found, check if the last 4 text items
  // could be one-option-per-line (common in English/scientific option PDFs).
  // The stem text is everything before the last 4 items.
  if (!lastOpts && textAfterStem.length >= 4) {
    // Try treating last 4 text items as options
    const last4 = textAfterStem.slice(-4)
    const allShort = last4.every(t => t.length < 100)
    // Heuristic: options should be similar in structure/length
    if (allShort) {
      lastOpts = { A: last4[0], B: last4[1], C: last4[2], D: last4[3] }
      // Remove the last 4 items from stemParts
      stemParts.splice(stemParts.length - 4, 4)
    }
  }

  if (!lastOpts) return null

  const clean = s => s.replace(/[\uE000-\uF8FF]/g, '').trim()
  const question = clean(stemParts.join(' '))
  return {
    question,
    options: {
      A: clean(lastOpts.A || ''), B: clean(lastOpts.B || ''),
      C: clean(lastOpts.C || ''), D: clean(lastOpts.D || ''),
    },
  }
}

// Parse a PDF once into both text and structured formats
// Cache by buffer reference; cleared between exam files to prevent mupdf OOM
const _pdfCache = new Map()
function clearPdfCache() { _pdfCache.clear(); if (global.gc) global.gc() }
async function parsePdf(buf) {
  if (_pdfCache.has(buf)) return _pdfCache.get(buf)
  const text = await fullPdfText(buf)
  const items = await fullPdfStructured(buf)
  const result = { text, items }
  _pdfCache.set(buf, result)
  return result
}

// Combined extractor: try labeled first, fall back to positional
async function extractQA(buf, N) {
  const { text, items } = await parsePdf(buf)

  // Try labeled approach first (works for PDFs with A/B/C/D markers)
  const labeled = extractQA_labeled(text, N)
  if (labeled && labeled.options.A && labeled.options.B && labeled.options.C && labeled.options.D) {
    return labeled
  }

  // Fall back to positional approach
  const positional = extractQA_positional(items, N)
  if (positional && positional.options.A && positional.options.B && positional.options.C && positional.options.D) {
    return positional
  }

  // Return whichever has more data
  if (labeled && positional) {
    const lFilled = Object.values(labeled.options).filter(v => v).length
    const pFilled = Object.values(positional.options).filter(v => v).length
    return pFilled > lFilled ? positional : labeled
  }
  return labeled || positional
}

// ─── Check if a question is broken ───

function isBroken(q) {
  const opts = q.options || {}
  const vals = Object.values(opts)
  const emptyCount = vals.filter(v => typeof v === 'string' && v.trim() === '').length
  const hasText = vals.filter(v => typeof v === 'string' && v.trim().length > 0).length

  // All 4 empty = image question, skip
  if (emptyCount === 4) return false

  // Some empty, some have text → broken
  if (emptyCount > 0 && hasText > 0) return true

  // Truncated circled-number list in question text
  const text = (q.question || '').trim()
  const allCircled = text.match(/[①②③④⑤⑥⑦⑧⑨⑩]/g)
  if (allCircled && allCircled.length >= 2) {
    const parts = text.split(/[①②③④⑤⑥⑦⑧⑨⑩]/).filter(Boolean)
    if (parts.length >= 2) {
      const avgLen = parts.slice(0, -1).reduce((s, p) => s + p.trim().length, 0) / (parts.length - 1)
      const last = parts[parts.length - 1].trim()
      if (last.length < avgLen * 0.4 && last.length < 8) return true
    }
  }

  // Option text has first char eaten (starts lowercase when rest has uppercase)
  for (const v of vals) {
    if (typeof v === 'string' && v.trim().length > 3) {
      const t = v.trim()
      if (/^[a-z]/.test(t) && /[A-Z]/.test(t.substring(1, 10))) return true
    }
  }

  // Question text spilled into option A: question has ①② list and option A starts
  // with Chinese text (continuation) containing ③ or higher circled numbers.
  // BUT: legitimate options like "僅①②③" or "①②③④" are short (<15 chars) — those are NOT spill.
  const optA = (q.options?.A || '').trim()
  if (text && optA && optA.length > 15) {
    const qCircled = text.match(/[①②③④⑤⑥⑦⑧⑨⑩]/g)
    if (qCircled && qCircled.length >= 1) {
      // Option A starts with Chinese, contains circled numbers, and is long = spill
      if (/^[\u4e00-\u9fff]/.test(optA) && /[①②③④⑤⑥⑦⑧⑨⑩]/.test(optA)) {
        return true
      }
    }
  }

  return false
}

// ─── Resolve exam def for a question ───

function getPapersForQuestion(def, examCode) {
  if (!def) return null
  const suffix = examCode.slice(3, 6) // e.g., "020" from "106020"

  // Session-specific class code mapping
  if (def.classCodeBySession && def.classCodeBySession[examCode]) {
    const cc = def.classCodeBySession[examCode]
    if (def.papersByClassCode && def.papersByClassCode[cc]) {
      // urlClassCode overrides the class code used in the URL (for exams where
      // subject codes vary by year but the actual class code is fixed)
      const urlCC = def.urlClassCode || cc
      return { classCode: urlCC, papers: def.papersByClassCode[cc] }
    }
  }

  // Code-suffix-specific papers (e.g., medlab 020 vs 090)
  if (def.papersByCode) {
    for (const [codeSuffix, papers] of Object.entries(def.papersByCode)) {
      if (suffix === codeSuffix) {
        return { classCode: def.classCode, papers }
      }
    }
  }

  // Default
  if (def.papers && def.papers.length > 0) {
    return { classCode: def.classCode, papers: def.papers }
  }
  return null
}

function findSubjectCode(papers, subject) {
  if (!papers) return null
  // Exact match
  let p = papers.find(p => p.subject === subject)
  if (p) return p.s
  // Partial match (subject might have extra text)
  p = papers.find(p => subject.includes(p.subject) || p.subject.includes(subject))
  if (p) return p.s
  return null
}

// ─── Main ───

;(async () => {
  const SKIP = ['driver-car', 'driver-moto', '_backup', ...SKIP_FILES.map(f => f.replace('questions-','').replace('.json',''))]
  const files = fs.readdirSync(BACKEND)
    .filter(f => f.startsWith('questions') && f.endsWith('.json') && !SKIP.some(p => f.includes(p)))

  if (examFilter) {
    const target = examFilter === 'doctor1' ? 'questions.json' : `questions-${examFilter}.json`
    if (!files.includes(target)) {
      console.error(`找不到 ${target}`)
      process.exit(1)
    }
    files.length = 0
    files.push(target)
  }

  let totalFixed = 0, totalSkipped = 0, totalBroken = 0

  for (const file of files) {
    const def = EXAM_DEFS[file]
    if (!def) {
      console.log(`⏭ ${file}: 無 EXAM_DEFS 定義，跳過`)
      continue
    }

    // Clear mupdf WASM memory between files to prevent OOM
    clearPdfCache()

    const filePath = path.join(BACKEND, file)
    const db = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const qs = db.questions || db
    if (!Array.isArray(qs)) continue

    // Find broken questions and group by (exam_code, subject)
    const broken = qs.filter(isBroken)
    if (broken.length === 0) continue

    totalBroken += broken.length
    console.log(`\n📋 ${file}: ${broken.length} 題需修復`)

    // Group by exam_code + subject
    const groups = {}
    for (const q of broken) {
      const key = `${q.exam_code}|${q.subject}`
      if (!groups[key]) groups[key] = []
      groups[key].push(q)
    }

    let fileFixed = 0
    for (const [key, groupQs] of Object.entries(groups).sort()) {
      const [examCode, subject] = key.split('|')
      const resolved = getPapersForQuestion(def, examCode)
      if (!resolved) {
        console.log(`  ⚠ ${examCode} ${subject}: 無法解析 classCode/papers`)
        totalSkipped += groupQs.length
        continue
      }

      const subjectCode = findSubjectCode(resolved.papers, subject)
      if (!subjectCode) {
        console.log(`  ⚠ ${examCode} ${subject}: 找不到 subject code (papers: ${resolved.papers.map(p => p.subject).join(', ')})`)
        totalSkipped += groupQs.length
        continue
      }

      const url = `${BASE_URL}?t=Q&code=${examCode}&c=${resolved.classCode}&s=${subjectCode}&q=1`
      const cacheKey = `${def.prefix}_${examCode}_c${resolved.classCode}_s${subjectCode}`

      // Clear between PDF groups to limit mupdf WASM memory
      clearPdfCache()
      let pdfBuf = null
      try {
        pdfBuf = await cachedPdf(cacheKey, url)
      } catch (e) {
        console.log(`  ⚠ ${examCode} ${subject}: PDF 下載/解析失敗: ${e.message}`)
        totalSkipped += groupQs.length
        continue
      }

      let groupFixed = 0
      for (const q of groupQs) {
        let parsed
        try {
          parsed = await extractQA(pdfBuf, q.number)
        } catch (e) {
          // mupdf OOM or other error — clear cache and skip
          clearPdfCache()
          totalSkipped++
          continue
        }
        if (!parsed) {
          totalSkipped++
          continue
        }

        // Only fix if the mupdf result is better
        const newQ = parsed.question
        const newOpts = parsed.options
        const allOptsFilled = newOpts.A && newOpts.B && newOpts.C && newOpts.D
        const newQBetter = newQ.length > (q.question || '').length * 0.8

        if (!allOptsFilled && !newQBetter) {
          totalSkipped++
          continue
        }

        // Apply fixes
        const changes = []
        if (newQ.length > (q.question || '').length && newQ.length > 10) {
          changes.push('Q')
          if (!DRY_RUN) q.question = newQ
        }

        // Detect spill case: question text leaked into option A
        // In this case old option A is garbage (contains circled numbers from question stem)
        // and the correct option from PDF is shorter, so "newV.length > oldV.length" fails.
        // Fix: when all 4 new options are filled, replace unconditionally if old options look broken.
        const oldA = (q.options?.A || '').trim()
        const spillDetected = allOptsFilled && (
          // Option A contains circled numbers that belong to question stem (long = spill, short = legit like "僅①②③")
          (/[①②③④⑤⑥⑦⑧⑨⑩]/.test(oldA) && /[\u4e00-\u9fff]/.test(oldA) && oldA.length > 15) ||
          // Option A is empty or very short while others exist
          (oldA.length === 0 && (q.options?.B || '').trim().length > 0) ||
          // Old options have empty entries but new ones are all filled
          (['A','B','C','D'].some(k => !(q.options?.[k] || '').trim()))
        )

        for (const k of ['A', 'B', 'C', 'D']) {
          const oldV = (q.options[k] || '').trim()
          const newV = newOpts[k].trim()
          if (!newV) continue
          // Replace if: new is longer (truncation fix), OR spill detected (replace all unconditionally)
          if (newV.length > oldV.length || spillDetected) {
            changes.push(k)
            if (!DRY_RUN) q.options[k] = newV
          }
        }

        if (changes.length > 0) {
          groupFixed++
          fileFixed++
          totalFixed++
          if (groupFixed <= 3 || process.argv.includes('--verbose')) {
            console.log(`  ✓ #${q.number} (${q.id}): 修復 ${changes.join('+')}`)
          }
        } else {
          totalSkipped++
        }
      }
      if (groupFixed > 3 && !process.argv.includes('--verbose')) {
        console.log(`    ... 共 ${groupFixed} 題 (${examCode} ${subject})`)
      }
      if (groupFixed === 0 && groupQs.length > 0) {
        console.log(`  ⚠ ${examCode} ${subject}: ${groupQs.length} 題全部無法修復`)
      }
    }
    // Save if any fixes applied to this file
    if (!DRY_RUN && fileFixed > 0) {
      if (db.metadata) db.metadata.last_updated = new Date().toISOString()
      const tmp = filePath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2))
      fs.renameSync(tmp, filePath)
    }
  }

  console.log(`\n${'═'.repeat(50)}`)
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}掃描完成`)
  console.log(`  偵測到 ${totalBroken} 題有問題`)
  console.log(`  修復: ${totalFixed} 題`)
  console.log(`  跳過: ${totalSkipped} 題`)
})().catch(e => { console.error(e); process.exit(1) })
