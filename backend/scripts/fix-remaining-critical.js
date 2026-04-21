#!/usr/bin/env node
// Fix remaining critical issues:
// 1. Image questions with label fragments → clear to all-empty + mark imageQuestion
// 2. English vocab-grid D_empty → use pdf.js vocab-grid parser
// 3. Download missing PDFs for civil-senior/judicial/lawyer1

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfjsLib = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')

const BACKEND = path.resolve(__dirname, '..')
const CACHE_DIRS = ['_tmp/pdf-cache-fix', '_tmp/pdf-cache', '_tmp/pdf-cache-gaps']
const CACHE = path.join(BACKEND, '_tmp', 'pdf-cache-fix')
const DRY_RUN = process.argv.includes('--dry')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s

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
  // Check all cache dirs
  for (const dir of CACHE_DIRS) {
    const base = path.join(BACKEND, dir)
    if (!fs.existsSync(base)) continue
    const exact = path.join(base, key + '.pdf')
    if (fs.existsSync(exact)) return fs.readFileSync(exact)
    for (const f of fs.readdirSync(base)) {
      if (f.includes(key) && f.endsWith('.pdf')) return fs.readFileSync(path.join(base, f))
    }
  }
  if (!url) return null
  console.log('  📥 Downloading', key)
  try {
    const buf = await fetchPdf(url)
    fs.writeFileSync(path.join(CACHE, key + '.pdf'), buf)
    return buf
  } catch (e) {
    console.log('  ⚠ Download failed:', e.message)
    return null
  }
}

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

// Vocab-grid parser (for English vocabulary questions)
function parseVocabGrid(rows) {
  const results = {}
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x)
    const nonEmpty = row.filter(r => r.str.trim().length > 0)
    if (nonEmpty.length < 3) continue
    const first = nonEmpty[0]
    if (first.x > 55) continue
    const num = parseInt(first.str.trim())
    if (isNaN(num) || num < 1 || num > 80) continue
    const optItems = nonEmpty.filter(r => r.x > 60 && r.str.trim().length > 0)
    if (optItems.length < 3) continue
    const xMin = optItems[0].x
    const xMax = optItems[optItems.length - 1].x
    if (xMax - xMin < 200) continue
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

// General MCQ parser (for questions with partial missing options)
function parseQuestionsFromPositional(items) {
  const mcqIdx = items.findIndex(it =>
    it.str.includes('測驗題部分') || it.str.includes('測驗題')
  )
  const mcqItems = mcqIdx >= 0 ? items.slice(mcqIdx) : items
  const rows = groupIntoRows(mcqItems)

  const qStarts = []
  let expectNext = 1
  for (let i = 0; i < rows.length; i++) {
    for (const item of rows[i]) {
      if (item.x > 60) continue
      const text = item.str.trim()
      const m = text.match(/^(\d{1,3})$/)
      if (m && parseInt(m[1]) === expectNext) {
        qStarts.push({ rowIdx: i, number: expectNext })
        expectNext++
        break
      }
    }
  }

  const questions = {}
  for (let qi = 0; qi < qStarts.length; qi++) {
    const startRow = qStarts[qi].rowIdx
    const endRow = qi + 1 < qStarts.length ? qStarts[qi + 1].rowIdx : rows.length
    const num = qStarts[qi].number
    const qRows = rows.slice(startRow, endRow)

    let stemParts = []
    const optionRows = []

    for (const row of qRows) {
      const nonEmpty = row.filter(r => r.str.trim().length > 0 && r.x > 50)
      if (nonEmpty.length === 0) continue
      const xs = nonEmpty.map(r => r.x)
      const xSpread = Math.max(...xs) - Math.min(...xs)
      const rowText = nonEmpty.map(r => r.str).join('').trim()
      const isStemLike = (rowText.includes('？') || rowText.includes('：') || rowText.includes('?')) && optionRows.length === 0

      if (isStemLike) {
        stemParts.push(rowText)
      } else if (xSpread > 100 && nonEmpty.length >= 2) {
        optionRows.push(nonEmpty)
      } else if (optionRows.length > 0) {
        optionRows.push(nonEmpty)
      } else if (stemParts.length > 0 && nonEmpty.length === 1 && nonEmpty[0].x >= 65 && nonEmpty[0].x <= 90) {
        optionRows.push(nonEmpty)
      } else {
        stemParts.push(rowText)
      }
    }

    const opts = []
    for (const row of optionRows) {
      row.sort((a, b) => a.x - b.x)
      const xs = row.map(r => r.x)
      const xSpread = Math.max(...xs) - Math.min(...xs)

      if (xSpread > 200 && row.length >= 4) {
        const groups = []
        let curGroup = [row[0]]
        for (let i = 1; i < row.length; i++) {
          if (row[i].x - row[i - 1].x < 50) {
            curGroup.push(row[i])
          } else {
            groups.push(curGroup)
            curGroup = [row[i]]
          }
        }
        groups.push(curGroup)
        for (const g of groups) {
          const text = g.map(r => r.str).join('').trim()
          if (text) opts.push(text)
        }
      } else if (xSpread > 100 && row.length >= 2) {
        const mid = (Math.min(...xs) + Math.max(...xs)) / 2
        const left = row.filter(r => r.x < mid).map(r => r.str).join('').trim()
        const right = row.filter(r => r.x >= mid).map(r => r.str).join('').trim()
        if (left) opts.push(left)
        if (right) opts.push(right)
      } else {
        const text = row.map(r => r.str).join('').trim()
        if (text) opts.push(text)
      }
    }

    if (opts.length >= 2) {
      const options = {}
      const labels = ['A', 'B', 'C', 'D']
      for (let i = 0; i < Math.min(opts.length, 4); i++) {
        options[labels[i]] = stripPUA(opts[i])
      }
      questions[num] = { question: stripPUA(stemParts.join(' ')), options }
    }
  }
  return questions
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── English vocab-grid exam definitions ───
const ENGLISH_DEFS = {
  'questions-civil-senior.json': {
    prefix: 'civil-senior',
    sessions: [
      { code: '114080', c: '201', s: '0401' },
    ],
  },
  'questions-judicial.json': {
    prefix: 'judicial',
    sessions: [
      { code: '114120', c: '101', s: '0309' },
    ],
  },
  'questions-lawyer1.json': {
    prefix: 'lawyer1',
    sessions: [
      // 綜合法學（公司法...法學英文）uses c=301, s=0202
      { code: '105110', c: '301', s: '0202' },
      { code: '107120', c: '301', s: '0202' },
      { code: '108120', c: '301', s: '0202' },
    ],
  },
}

// ─── Nutrition/other general MCQ definitions ───
const GENERAL_DEFS = {
  'questions-nutrition.json': {
    prefix: 'nutrition',
    classCodeBySession: {
      '107030': '103', '107110': '103', '108020': '103', '108110': '103',
      '115030': '102',
    },
    papersByCC: {
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
  },
  'questions-pharma1.json': {
    prefix: 'pharma1',
    classCodeBySession: {
      '109020': '305',
    },
    papersByCC: {
      '305': [
        { s: '33', subject: '卷一' }, { s: '44', subject: '卷二' }, { s: '55', subject: '卷三' },
      ],
    },
  },
  'questions-social-worker.json': {
    prefix: 'social-worker',
    classCodeBySession: {
      '113030': '107', '115030': '107',
    },
    papersByCC: {
      '107': [
        { s: '0601', subject: '社會工作' }, { s: '0602', subject: '社會工作直接服務' },
        { s: '0603', subject: '社會工作管理' },
      ],
    },
  },
  'questions-tcm2.json': {
    prefix: 'tcm2',
    classCodeBySession: {
      '110030': '102',
    },
    papersByCC: {
      '102': [
        { s: '0103', subject: '中醫臨床醫學(一)' }, { s: '0104', subject: '中醫臨床醫學(二)' },
        { s: '0105', subject: '中醫臨床醫學(三)' }, { s: '0106', subject: '中醫臨床醫學(四)' },
      ],
    },
  },
}

// ─── Vet subject name → paper code mapping ───
// Old vet exams (106-109, c=309) use specific subject names instead of 獸醫學(一)-(六)
// Vet/medical exam parser — handles "1." format (number + period at left margin)
function parseVetQuestions(items) {
  const rows = groupIntoRows(items)
  const qStarts = []
  let expectNext = 1
  for (let i = 0; i < rows.length; i++) {
    for (const item of rows[i]) {
      if (item.x > 60) continue
      const text = item.str.trim()
      // Match "N." or "N" format
      const m = text.match(/^(\d{1,3})\.?$/)
      if (m && parseInt(m[1]) === expectNext) {
        qStarts.push({ rowIdx: i, number: expectNext })
        expectNext++
        break
      }
    }
  }

  const questions = {}
  for (let qi = 0; qi < qStarts.length; qi++) {
    const startRow = qStarts[qi].rowIdx
    const endRow = qi + 1 < qStarts.length ? qStarts[qi + 1].rowIdx : rows.length
    const num = qStarts[qi].number
    const qRows = rows.slice(startRow, endRow)

    let stemParts = []
    const optionRows = []

    for (const row of qRows) {
      const nonEmpty = row.filter(r => r.str.trim().length > 0 && r.x > 25)
      if (nonEmpty.length === 0) continue
      const xs = nonEmpty.map(r => r.x)
      const xSpread = Math.max(...xs) - Math.min(...xs)
      const rowText = nonEmpty.map(r => r.str).join('').trim()

      // Detect option rows: labeled (A)/(B)/(C)/(D) or multi-column spread
      const hasOptionLabel = /^\(?[A-D]\)?[\.\s]/.test(rowText) || /\(?[A-D]\)?[\.\s]/.test(nonEmpty[0].str.trim())

      if (hasOptionLabel || (optionRows.length > 0 && xSpread < 100 && nonEmpty.length <= 3)) {
        optionRows.push(nonEmpty)
      } else if (xSpread > 100 && nonEmpty.length >= 2 && optionRows.length > 0) {
        optionRows.push(nonEmpty)
      } else if (xSpread > 200 && nonEmpty.length >= 4) {
        optionRows.push(nonEmpty)
      } else {
        if (optionRows.length > 0) optionRows.push(nonEmpty)
        else stemParts.push(rowText)
      }
    }

    // Parse options — try labeled (A)(B)(C)(D) first
    const opts = {}
    const allText = optionRows.map(row => row.map(r => r.str).join('')).join('\n')

    // Try to extract by (A)/(B)/(C)/(D) labels
    const labelMatch = allText.match(/\(?A\)?[\.、\s](.+?)(?:\(?B\)?[\.、\s])/s)
    if (labelMatch) {
      // Use regex to split by option labels
      const combined = allText.replace(/\n/g, ' ')
      const parts = combined.split(/\(?([A-D])\)?[\.、\s]/)
      let currentLabel = null
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i].trim()
        if (/^[A-D]$/.test(p)) { currentLabel = p }
        else if (currentLabel && p) { opts[currentLabel] = stripPUA(p); currentLabel = null }
      }
    }

    // Fallback: positional grouping
    if (Object.keys(opts).length < 2) {
      const flatOpts = []
      for (const row of optionRows) {
        row.sort((a, b) => a.x - b.x)
        const xs = row.map(r => r.x)
        const xSpread = Math.max(...xs) - Math.min(...xs)
        if (xSpread > 200 && row.length >= 4) {
          const groups = []
          let curGroup = [row[0]]
          for (let i = 1; i < row.length; i++) {
            if (row[i].x - row[i - 1].x < 50) curGroup.push(row[i])
            else { groups.push(curGroup); curGroup = [row[i]] }
          }
          groups.push(curGroup)
          for (const g of groups) {
            const text = g.map(r => r.str).join('').trim()
            if (text) flatOpts.push(text)
          }
        } else if (xSpread > 100 && row.length >= 2) {
          const mid = (Math.min(...xs) + Math.max(...xs)) / 2
          const left = row.filter(r => r.x < mid).map(r => r.str).join('').trim()
          const right = row.filter(r => r.x >= mid).map(r => r.str).join('').trim()
          if (left) flatOpts.push(left)
          if (right) flatOpts.push(right)
        } else {
          const text = row.map(r => r.str).join('').trim()
          if (text) flatOpts.push(text)
        }
      }
      // Strip option labels
      const labels = ['A', 'B', 'C', 'D']
      for (let i = 0; i < Math.min(flatOpts.length, 4); i++) {
        let text = flatOpts[i].replace(/^\(?[A-D]\)?[\.、\s]+/, '').trim()
        opts[labels[i]] = stripPUA(text)
      }
    }

    if (Object.keys(opts).length >= 2) {
      questions[num] = { question: stripPUA(stemParts.join(' ')), options: opts }
    }
  }
  return questions
}

// Mapping verified against exam-configs/vet.json paper order
const VET_SUBJECT_MAP = {
  '獸醫病理學': '11',       // paper1
  '獸醫藥理學': '22',       // paper2
  '獸醫實驗診斷學': '33',   // paper3
  '獸醫普通疾病學': '44',   // paper4
  '獸醫傳染病學': '55',     // paper5
  '獸醫公共衛生學': '66',   // paper6
}

async function main() {
  let totalFixed = 0

  // ═══ Part 1: Fix image questions with label fragments ═══
  console.log('\n═══ Part 1: 圖片題標記修正 ═══')
  const allFiles = fs.readdirSync(BACKEND).filter(f => f.startsWith('questions') && f.endsWith('.json'))
  let imageFixed = 0

  for (const fileName of allFiles) {
    const filePath = path.join(BACKEND, fileName)
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const qs = data.questions || data
    if (!Array.isArray(qs)) continue

    let fileFixed = 0
    for (const q of qs) {
      const vals = ['A', 'B', 'C', 'D'].map(k => (q.options[k] || '').trim())
      const nonEmpty = vals.filter(v => v)
      const emptyCount = vals.filter(v => !v).length
      if (emptyCount === 0 || nonEmpty.length === 0) continue

      // Check if remaining non-empty values are just label fragments (A., B., C., D.)
      const isLabelOnly = nonEmpty.every(v => /^[A-D]\.?$/.test(v) || v.length <= 2)
      if (!isLabelOnly) continue

      // Clear to all-empty (proper image question)
      if (!DRY_RUN) {
        for (const k of ['A', 'B', 'C', 'D']) q.options[k] = ''
      }
      fileFixed++
    }

    if (fileFixed > 0) {
      if (!DRY_RUN) {
        if (!Array.isArray(data)) data.total = (data.questions || []).length
        const tmp = filePath + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
        fs.renameSync(tmp, filePath)
      }
      console.log(`  ✓ ${fileName}: ${fileFixed} 圖片題已清理`)
      imageFixed += fileFixed
    }
  }
  console.log(`  → 圖片題: ${imageFixed} 修復`)
  totalFixed += imageFixed

  // ═══ Part 2: English vocab-grid D_empty ═══
  console.log('\n═══ Part 2: 英文詞彙格 Option D 修復 ═══')
  let vocabFixed = 0

  for (const [fileName, def] of Object.entries(ENGLISH_DEFS)) {
    const filePath = path.join(BACKEND, fileName)
    if (!fs.existsSync(filePath)) continue
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const qs = data.questions || data
    if (!Array.isArray(qs)) continue

    // Find questions with empty options in the relevant subjects
    const broken = qs.filter(q => {
      if (!q.subject) return false
      // Match English-containing subjects or lawyer1 綜合法學3
      const isRelevant = q.subject.includes('英文') || q.subject.includes('法學英文') ||
        q.subject.includes('綜合法學（公司法') || q.subject.includes('法學知識')
      if (!isRelevant) return false
      return ['A', 'B', 'C', 'D'].some(k => !(q.options[k] || '').trim())
    })
    if (broken.length === 0) continue

    let fileFixed = 0
    for (const sess of def.sessions) {
      const sessQs = broken.filter(q => q.exam_code === sess.code)
      if (sessQs.length === 0) continue

      const url = `${BASE}?t=Q&code=${sess.code}&c=${sess.c}&s=${sess.s}&q=1`
      const cacheKey = `${def.prefix}_${sess.code}_c${sess.c}_s${sess.s}`
      const buf = await cachedPdf(cacheKey, url)
      if (!buf) continue

      const items = await extractAllItems(buf)
      const rows = groupIntoRows(items)
      const gridOpts = parseVocabGrid(rows)

      // Also try general MCQ parser as fallback
      const mcqParsed = parseQuestionsFromPositional(items)

      let sessFixed = 0
      for (const q of sessQs) {
        // Try vocab grid first
        let opts = gridOpts[q.number]
        if (!opts && mcqParsed[q.number]) opts = mcqParsed[q.number].options
        if (!opts) continue

        let changed = false
        for (const k of ['A', 'B', 'C', 'D']) {
          const newV = (opts[k] || '').trim()
          const oldV = (q.options[k] || '').trim()
          if (newV && (!oldV || newV.length > oldV.length)) {
            if (!DRY_RUN) q.options[k] = newV
            changed = true
          }
        }
        if (changed) sessFixed++
      }
      console.log(`  ${sessFixed > 0 ? '✓' : '⚠'} ${fileName} ${sess.code}: ${sessFixed}/${sessQs.length}`)
      fileFixed += sessFixed
      await sleep(500)
    }

    if (!DRY_RUN && fileFixed > 0) {
      if (!Array.isArray(data)) data.total = (data.questions || []).length
      const tmp = filePath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
      fs.renameSync(tmp, filePath)
    }
    vocabFixed += fileFixed
  }
  console.log(`  → 英文詞彙格: ${vocabFixed} 修復`)
  totalFixed += vocabFixed

  // ═══ Part 3: General MCQ with missing options (download + re-parse) ═══
  console.log('\n═══ Part 3: 一般題目 (下載+重新解析) ═══')
  let generalFixed = 0

  for (const [fileName, def] of Object.entries(GENERAL_DEFS)) {
    const filePath = path.join(BACKEND, fileName)
    if (!fs.existsSync(filePath)) continue
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const qs = data.questions || data
    if (!Array.isArray(qs)) continue

    const broken = qs.filter(q => {
      const vals = ['A', 'B', 'C', 'D'].map(k => (q.options[k] || '').trim())
      return vals.filter(v => !v).length > 0 && vals.filter(v => v).length > 0
    })
    if (broken.length === 0) continue

    const groups = {}
    for (const q of broken) {
      const key = `${q.exam_code}|${q.subject}`
      if (!groups[key]) groups[key] = []
      groups[key].push(q)
    }

    let fileFixed = 0
    for (const [key, groupQs] of Object.entries(groups).sort()) {
      const [examCode, subject] = key.split('|')
      const cc = def.classCodeBySession[examCode]
      if (!cc) continue
      const papers = def.papersByCC[cc]
      if (!papers) continue
      const paper = papers.find(p => p.subject === subject || subject.includes(p.subject) || p.subject.includes(subject))
      if (!paper) continue

      const url = `${BASE}?t=Q&code=${examCode}&c=${cc}&s=${paper.s}&q=1`
      const cacheKey = `${def.prefix}_${examCode}_c${cc}_s${paper.s}`
      const buf = await cachedPdf(cacheKey, url)
      if (!buf) continue

      let parsed
      try {
        const items = await extractAllItems(buf)
        parsed = parseQuestionsFromPositional(items)
      } catch (e) {
        console.log(`  ⚠ ${examCode} ${subject}: 解析失敗: ${e.message}`)
        continue
      }

      let groupFixed = 0
      for (const q of groupQs) {
        const p = parsed[q.number]
        if (!p) continue
        let changed = false
        for (const k of ['A', 'B', 'C', 'D']) {
          const newV = (p.options[k] || '').trim()
          const oldV = (q.options[k] || '').trim()
          if (newV && (!oldV || newV.length > oldV.length)) {
            if (!DRY_RUN) q.options[k] = newV
            changed = true
          }
        }
        if (changed) groupFixed++
      }
      const status = groupFixed > 0 ? '✓' : '⚠'
      console.log(`  ${status} ${fileName} ${examCode} ${subject}: ${groupFixed}/${groupQs.length}`)
      fileFixed += groupFixed
      await sleep(500)
    }

    if (!DRY_RUN && fileFixed > 0) {
      if (!Array.isArray(data)) data.total = (data.questions || []).length
      const tmp = filePath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
      fs.renameSync(tmp, filePath)
    }
    generalFixed += fileFixed
  }
  console.log(`  → 一般題目: ${generalFixed} 修復`)
  totalFixed += generalFixed

  // ═══ Part 4: Vet subject name mapping fix ═══
  console.log('\n═══ Part 4: 獸醫科目名稱對映修復 ═══')
  let vetFixed = 0

  const vetFile = path.join(BACKEND, 'questions-vet.json')
  if (fs.existsSync(vetFile)) {
    const data = JSON.parse(fs.readFileSync(vetFile, 'utf8'))
    const qs = data.questions || data

    const broken = qs.filter(q => {
      const vals = ['A', 'B', 'C', 'D'].map(k => (q.options[k] || '').trim())
      return vals.filter(v => !v).length > 0 && vals.filter(v => v).length > 0
    })

    for (const q of broken) {
      const subjectCode = VET_SUBJECT_MAP[q.subject]
      if (!subjectCode) continue

      // Vet sessions all use c=314 with 2-digit subject codes (11-66)
      const cc = '314'
      const cacheKey = `vet_${q.exam_code}_c${cc}_s${subjectCode}`
      const buf = await cachedPdf(cacheKey, null)
      if (!buf) {
        // Try downloading
        const url = `${BASE}?t=Q&code=${q.exam_code}&c=${cc}&s=${subjectCode}&q=1`
        const buf2 = await cachedPdf(`vet_${q.exam_code}_c${cc}_s${subjectCode}`, url)
        if (!buf2) {
          console.log(`  ⚠ vet ${q.exam_code} ${q.subject}: 無 PDF`)
          continue
        }
        const items = await extractAllItems(buf2)
        const parsed = parseQuestionsFromPositional(items)
        const items2 = await extractAllItems(buf2)
        const parsed2 = parseVetQuestions(items2)
        const p = parsed2[q.number]
        if (!p) continue
        let changed = false
        for (const k of ['A', 'B', 'C', 'D']) {
          const newV = (p.options[k] || '').trim()
          const oldV = (q.options[k] || '').trim()
          if (newV && (!oldV || newV.length > oldV.length)) {
            if (!DRY_RUN) q.options[k] = newV
            changed = true
          }
        }
        if (changed) { vetFixed++; console.log(`  ✓ vet ${q.exam_code} ${q.subject} #${q.number}`) }
        await sleep(500)
        continue
      }

      let parsed
      try {
        const items = await extractAllItems(buf)
        parsed = parseVetQuestions(items)
      } catch (e) { continue }

      const p = parsed[q.number]
      if (!p) continue
      let changed = false
      for (const k of ['A', 'B', 'C', 'D']) {
        const newV = (p.options[k] || '').trim()
        const oldV = (q.options[k] || '').trim()
        if (newV && (!oldV || newV.length > oldV.length)) {
          if (!DRY_RUN) q.options[k] = newV
          changed = true
        }
      }
      if (changed) { vetFixed++; console.log(`  ✓ vet ${q.exam_code} ${q.subject} #${q.number}`) }
    }

    if (!DRY_RUN && vetFixed > 0) {
      if (!Array.isArray(data)) data.total = (data.questions || []).length
      const tmp = vetFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
      fs.renameSync(tmp, vetFile)
    }
  }
  console.log(`  → 獸醫: ${vetFixed} 修復`)
  totalFixed += vetFixed

  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}總計: ${totalFixed} 修復`)
}

main().catch(e => { console.error(e); process.exit(1) })
