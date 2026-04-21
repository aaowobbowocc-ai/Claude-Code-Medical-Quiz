#!/usr/bin/env node
// Fix nutrition broken questions using pdf.js position-based extraction
// The nutrition PDFs use a grid format without A/B/C/D labels,
// and mupdf can't extract span-level position data for these.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const pdfjsLib = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')

const BACKEND = path.resolve(__dirname, '..')
const CACHE_DIRS = ['_tmp/pdf-cache-fix', '_tmp/pdf-cache', '_tmp/pdf-cache-gaps']
const DRY_RUN = process.argv.includes('--dry')

const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s

// Session → class code mapping (same as fix-truncated-mupdf.js)
const CLASS_CODE_BY_SESSION = {
  '106030': '103', '106110': '103', '107030': '103', '107110': '103',
  '108020': '103', '109030': '103', '109110': '103',
  '108110': '103', '110030': '103', '110111': '103',
  '111030': '103', '111110': '103',
  '112030': '102', '112110': '102',
  '113030': '102', '113100': '102',
  '114030': '102', '114100': '102',
  '115030': '102',
}

const PAPERS_BY_CC = {
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
}

function findCachedPdf(cacheKey) {
  for (const dir of CACHE_DIRS) {
    const base = path.join(BACKEND, dir)
    if (!fs.existsSync(base)) continue
    // Exact match
    const exact = path.join(base, cacheKey + '.pdf')
    if (fs.existsSync(exact)) return fs.readFileSync(exact)
    // Partial match
    for (const f of fs.readdirSync(base)) {
      if (f.includes(cacheKey) && f.endsWith('.pdf')) return fs.readFileSync(path.join(base, f))
    }
  }
  return null
}

async function extractPositionedText(buf) {
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

// Parse question+options from positional data
// Nutrition format: Q number at x~41, stem at x~60, options at x~60/185/313/439
function parseQuestionsFromPositional(items) {
  // Skip to MCQ section
  const mcqIdx = items.findIndex(it => it.str.includes('測驗題部分') || it.str.includes('測驗題'))
  const mcqItems = mcqIdx >= 0 ? items.slice(mcqIdx) : items

  const rows = groupIntoRows(mcqItems)

  // Find question start rows (number at x < 50)
  const qStarts = []
  let expectNext = 1
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    for (const item of row) {
      if (item.x > 50) continue
      const text = item.str.trim()
      const m = text.match(/^(\d{1,2})$/)
      if (m && parseInt(m[1]) === expectNext) {
        qStarts.push({ rowIdx: i, number: expectNext })
        expectNext++
        break
      }
    }
  }

  // Extract Q+options for each question
  const questions = {}
  for (let qi = 0; qi < qStarts.length; qi++) {
    const startRow = qStarts[qi].rowIdx
    const endRow = qi + 1 < qStarts.length ? qStarts[qi + 1].rowIdx : rows.length
    const num = qStarts[qi].number

    const qRows = rows.slice(startRow, endRow)

    // First row after Q number: stem text (at x ~60)
    // Collect stem lines (x ~55-70, full width)
    // Collect option rows (has items at multiple x positions 60/185/313/439)
    let stemParts = []
    const optionRows = []

    for (const row of qRows) {
      const nonEmpty = row.filter(r => r.str.trim().length > 0 && r.x > 50)
      if (nonEmpty.length === 0) continue

      // Check if this is a multi-column option row
      const xs = nonEmpty.map(r => r.x)
      const xSpread = Math.max(...xs) - Math.min(...xs)

      if (xSpread > 100 && nonEmpty.length >= 2) {
        // Multi-column: options on one row
        optionRows.push(nonEmpty)
      } else if (nonEmpty.length === 1 && nonEmpty[0].x >= 55 && nonEmpty[0].x <= 75) {
        // Single item at stem indent
        const text = nonEmpty[0].str.trim()
        if (optionRows.length > 0) {
          // After options started, this is a single-line option
          optionRows.push(nonEmpty)
        } else {
          stemParts.push(text)
        }
      } else {
        // Could be stem continuation or single-line option
        if (optionRows.length > 0) {
          optionRows.push(nonEmpty)
        } else {
          stemParts.push(nonEmpty.map(r => r.str).join('').trim())
        }
      }
    }

    // Parse options from option rows
    const opts = []
    for (const row of optionRows) {
      row.sort((a, b) => a.x - b.x)
      const xs = row.map(r => r.x)
      const xSpread = Math.max(...xs) - Math.min(...xs)

      if (xSpread > 200 && row.length >= 4) {
        // 4-column row
        // Group by x proximity (items within 20px are part of same option)
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
        // 2-column row
        const mid = (Math.min(...xs) + Math.max(...xs)) / 2
        const left = row.filter(r => r.x < mid)
        const right = row.filter(r => r.x >= mid)
        const leftText = left.map(r => r.str).join('').trim()
        const rightText = right.map(r => r.str).join('').trim()
        if (leftText) opts.push(leftText)
        if (rightText) opts.push(rightText)
      } else {
        // Single option
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
      questions[num] = {
        question: stripPUA(stemParts.join(' ')),
        options,
      }
    }
  }
  return questions
}

async function main() {
  const file = path.join(BACKEND, 'questions-nutrition.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const qs = data.questions || data

  // Find broken questions (partial empty options, not all-empty image questions)
  const broken = qs.filter(q => {
    const vals = ['A', 'B', 'C', 'D'].map(k => (q.options[k] || '').trim())
    const empty = vals.filter(v => !v).length
    const filled = vals.filter(v => v).length
    return empty > 0 && filled > 0
  })
  console.log(`找到 ${broken.length} 題有空選項`)

  // Group by exam_code + subject
  const groups = {}
  for (const q of broken) {
    const key = `${q.exam_code}|${q.subject}`
    if (!groups[key]) groups[key] = []
    groups[key].push(q)
  }

  let totalFixed = 0, totalSkipped = 0
  for (const [key, groupQs] of Object.entries(groups).sort()) {
    const [examCode, subject] = key.split('|')
    const cc = CLASS_CODE_BY_SESSION[examCode]
    if (!cc) {
      console.log(`  ⚠ ${examCode} ${subject}: 無 class code 映射`)
      totalSkipped += groupQs.length
      continue
    }
    const papers = PAPERS_BY_CC[cc]
    if (!papers) {
      console.log(`  ⚠ ${examCode} ${subject}: 無 papers 定義 (cc=${cc})`)
      totalSkipped += groupQs.length
      continue
    }
    const paper = papers.find(p => p.subject === subject)
    if (!paper) {
      console.log(`  ⚠ ${examCode} ${subject}: 找不到 subject code`)
      totalSkipped += groupQs.length
      continue
    }

    // Find cached PDF
    const cacheKey = `nutrition_${examCode}_c${cc}_s${paper.s}`
    const buf = findCachedPdf(cacheKey)
    if (!buf) {
      console.log(`  ⚠ ${examCode} ${subject}: 無快取 PDF (${cacheKey})`)
      totalSkipped += groupQs.length
      continue
    }

    let parsed
    try {
      const items = await extractPositionedText(buf)
      parsed = parseQuestionsFromPositional(items)
    } catch (e) {
      console.log(`  ⚠ ${examCode} ${subject}: PDF 解析失敗: ${e.message}`)
      totalSkipped += groupQs.length
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
      // Also improve question text if richer
      const newQ = (p.question || '').trim()
      if (newQ && newQ.length > (q.question || '').length) {
        if (!DRY_RUN) q.question = newQ
        changed = true
      }
      if (changed) groupFixed++
    }
    const status = groupFixed > 0 ? '✓' : '⚠'
    console.log(`  ${status} ${examCode} ${subject}: ${groupFixed}/${groupQs.length} 修復`)
    totalFixed += groupFixed
    totalSkipped += groupQs.length - groupFixed
  }

  if (!DRY_RUN && totalFixed > 0) {
    if (Array.isArray(data)) {
      // plain array format
    } else {
      data.total = (data.questions || []).length
    }
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file)
  }

  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}完成: ${totalFixed} 修復, ${totalSkipped} 跳過`)
}

main().catch(e => { console.error(e); process.exit(1) })
