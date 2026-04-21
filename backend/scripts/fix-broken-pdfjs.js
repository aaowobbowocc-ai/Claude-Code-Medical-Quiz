#!/usr/bin/env node
// Fix broken questions (partial empty options) using pdf.js position-based extraction.
// For PDFs where mupdf can't extract span-level data (older exams).
// Supports: nursing, nutrition, and other exams with mixed essay+MCQ format.
//
// Usage:
//   node scripts/fix-broken-pdfjs.js --exam nursing --dry
//   node scripts/fix-broken-pdfjs.js --exam nutrition
//   node scripts/fix-broken-pdfjs.js              # all supported exams

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const pdfjsLib = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')

const BACKEND = path.resolve(__dirname, '..')
const CACHE_DIRS = ['_tmp/pdf-cache-fix', '_tmp/pdf-cache', '_tmp/pdf-cache-gaps']
const DRY_RUN = process.argv.includes('--dry')
const examFilter = process.argv.includes('--exam') ? process.argv[process.argv.indexOf('--exam') + 1] : null

const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s

// ─── Exam definitions ───

const EXAM_DEFS = {
  'questions-nutrition.json': {
    prefix: 'nutrition',
    classCodeBySession: {
      '106030': '103', '106110': '103', '107030': '103', '107110': '103',
      '108020': '103', '108110': '103', '109030': '103', '109110': '103',
      '110030': '103', '110111': '103', '111030': '103', '111110': '103',
      '112030': '102', '112110': '102', '113030': '102', '113100': '102',
      '114030': '102', '114100': '102', '115030': '102',
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
  'questions-nursing.json': {
    prefix: 'nursing',
    classCodeBySession: {
      '106030': '106', '106110': '106', '107030': '106', '107110': '106',
      '108020': '106', '108110': '106', '109030': '106', '109110': '106',
      '110030': '104', '110110': '104', '111030': '104', '111110': '104',
      '112030': '102', '112110': '102', '113030': '104', '113100': '104',
      '114030': '101', '114100': '101', '115030': '101',
    },
    papersByCC: {
      '106': [
        { s: '0501', subject: '基礎醫學' }, { s: '0502', subject: '基本護理學與護理行政' },
        { s: '0503', subject: '內外科護理學' }, { s: '0504', subject: '產兒科護理學' },
        { s: '0505', subject: '精神科與社區衛生護理學' },
      ],
      '104': [
        { s: '0301', subject: '基礎醫學' }, { s: '0302', subject: '基本護理學與護理行政' },
        { s: '0303', subject: '內外科護理學' }, { s: '0304', subject: '產兒科護理學' },
        { s: '0305', subject: '精神科與社區衛生護理學' },
      ],
      '102': [
        { s: '0201', subject: '基礎醫學' }, { s: '0202', subject: '基本護理學與護理行政' },
        { s: '0203', subject: '內外科護理學' }, { s: '0204', subject: '產兒科護理學' },
        { s: '0205', subject: '精神科與社區衛生護理學' },
      ],
      '101': [
        { s: '0101', subject: '基礎醫學' }, { s: '0102', subject: '基本護理學與護理行政' },
        { s: '0103', subject: '內外科護理學' }, { s: '0104', subject: '產兒科護理學' },
        { s: '0105', subject: '精神科與社區衛生護理學' },
      ],
    },
  },
  'questions.json': {
    prefix: 'doctor1',
    classCodeBySession: {
      '106020': '301', '106080': '301', '107020': '301', '107080': '301',
      '108030': '301', '108080': '301', '109020': '301', '109080': '301',
      '110020': '301', '110080': '301', '111020': '301', '111080': '301',
      '112020': '301', '112090': '301', '113020': '301', '113090': '301',
      '114020': '301', '115020': '301',
    },
    papersByCC: {
      '301': [
        { s: '11', subject: '醫學(一)' }, { s: '22', subject: '醫學(二)' },
      ],
    },
  },
  'questions-doctor2.json': {
    prefix: 'doctor2',
    classCodeBySession: {
      '106020': '302', '106080': '302', '107020': '302', '107080': '302',
      '108030': '302', '108080': '302', '109020': '302', '109080': '302',
      '110020': '302', '110080': '302', '111020': '302', '111080': '302',
      '112020': '302', '112090': '302', '113020': '302', '113090': '302',
      '114020': '302', '115020': '302',
    },
    papersByCC: {
      '302': [
        { s: '11', subject: '醫學(三)' }, { s: '22', subject: '醫學(四)' },
        { s: '33', subject: '醫學(五)' }, { s: '44', subject: '醫學(六)' },
      ],
    },
  },
  'questions-dental1.json': {
    prefix: 'dental1',
    classCodeBySession: {
      '106020': '303', '106100': '303', '107020': '303', '107100': '303',
      '108030': '303', '108100': '303', '109020': '303', '109100': '303',
      '110020': '303', '110101': '303', '111020': '303', '111100': '303',
      '112020': '303', '112100': '303', '113020': '303', '113090': '303',
      '114020': '303', '114090': '303', '115020': '303',
    },
    papersByCC: {
      '303': [
        { s: '11', subject: '卷一' }, { s: '22', subject: '卷二' },
      ],
    },
  },
  'questions-dental2.json': {
    prefix: 'dental2',
    classCodeBySession: {
      '106020': '304', '106100': '304', '107020': '304', '107100': '304',
      '108030': '304', '108100': '304', '109020': '304', '109100': '304',
      '110020': '304', '110100': '304', '111020': '304', '111100': '304',
      '112020': '304', '112100': '304', '113020': '304', '113090': '304',
      '114020': '304', '114090': '304', '115020': '304',
    },
    papersByCC: {
      '304': [
        { s: '33', subject: '卷一' }, { s: '44', subject: '卷二' },
        { s: '55', subject: '卷三' }, { s: '66', subject: '卷四' },
      ],
    },
  },
  'questions-pharma1.json': {
    prefix: 'pharma1',
    classCodeBySession: {
      '106020': '305', '106100': '305', '107020': '305', '107100': '305',
      '108030': '305', '108100': '305', '109020': '305', '109100': '305',
      '110020': '305', '110101': '305', '111020': '305', '111100': '305',
      '112020': '305', '112100': '305', '113020': '305', '113090': '305',
      '114020': '305', '115020': '305',
    },
    papersByCC: {
      '305': [
        { s: '33', subject: '卷一' }, { s: '44', subject: '卷二' },
        { s: '55', subject: '卷三' },
      ],
    },
  },
  'questions-medlab.json': {
    prefix: 'medlab',
    classCodeBySession: {
      '106020': '308', '106100': '308', '107020': '308', '107100': '308',
      '108030': '308', '108100': '308', '109020': '308', '109100': '308',
      '110020': '308', '110090': '308', '111020': '308', '111090': '308',
      '112020': '308', '112090': '308', '113020': '308', '113090': '308',
      '114020': '308', '114090': '308', '115020': '308',
    },
    papersByCC: {
      '308': [
        { s: '11', subject: '臨床生理學與病理學' }, { s: '22', subject: '臨床血液學與血庫學' },
        { s: '33', subject: '醫學分子檢驗學與臨床鏡檢學' }, { s: '44', subject: '微生物學與臨床微生物學' },
        { s: '55', subject: '生物化學與臨床生化學' }, { s: '66', subject: '臨床血清免疫學與臨床病毒學' },
      ],
    },
  },
  'questions-pt.json': {
    prefix: 'pt',
    classCodeBySession: {
      '106020': '311', '106100': '311', '107020': '311', '107100': '311',
      '108030': '311', '108100': '311', '109020': '311', '109100': '311',
      '110020': '311', '110090': '311', '111020': '311', '111090': '311',
      '112020': '311', '112090': '311', '113020': '311', '113090': '311',
      '114020': '311', '114090': '311', '115020': '311',
    },
    papersByCC: {
      '311': [
        { s: '11', subject: '神經疾病物理治療學' }, { s: '22', subject: '骨科疾病物理治療學' },
        { s: '33', subject: '心肺疾病與小兒疾病物理治療學' }, { s: '44', subject: '物理治療基礎學' },
        { s: '55', subject: '物理治療學概論' }, { s: '66', subject: '物理治療技術學' },
      ],
    },
  },
  'questions-ot.json': {
    prefix: 'ot',
    classCodeBySession: {
      '106020': '312', '106100': '312', '107020': '312', '107100': '312',
      '108030': '312', '108100': '312', '109020': '312', '109100': '312',
      '110020': '312', '110090': '312', '111020': '312', '111090': '312',
      '112020': '312', '112090': '312', '113020': '312', '113090': '312',
      '114020': '312', '114090': '312', '115020': '312',
    },
    papersByCC: {
      '312': [
        { s: '11', subject: '解剖學與生理學' }, { s: '22', subject: '職能治療學概論' },
        { s: '33', subject: '生理疾病職能治療學' }, { s: '44', subject: '心理疾病職能治療學' },
        { s: '55', subject: '小兒疾病職能治療學' }, { s: '66', subject: '職能治療技術學' },
      ],
    },
  },
  'questions-radiology.json': {
    prefix: 'radiology',
    classCodeBySession: {
      '106020': '309', '106100': '309', '107020': '309', '107100': '309',
      '108030': '309', '108100': '309', '109020': '309', '109100': '309',
      '110020': '309', '110100': '309', '111020': '309', '111100': '309',
      '112020': '309', '112100': '309', '113020': '309', '113090': '309',
      '114020': '309', '114090': '309', '115020': '309',
    },
    papersByCC: {
      '309': [
        { s: '11', subject: '基礎醫學（包括解剖學、生理學與病理學）' },
        { s: '22', subject: '醫學物理學與輻射安全' },
        { s: '33', subject: '放射線器材學（包括磁振學與超音波學）' },
        { s: '44', subject: '放射線診斷原理與技術學' },
        { s: '55', subject: '放射線治療原理與技術學' },
        { s: '66', subject: '核子醫學診療原理與技術學' },
      ],
    },
  },
  'questions-tcm1.json': {
    prefix: 'tcm1',
    classCodeBySession: {
      '106030': '101', '106110': '101', '107030': '101', '107110': '101',
      '108020': '101', '108110': '101',
      '109030': '101', '109110': '101',
      '110030': '101', '110111': '101',
      '112020': '317', '112090': '317', '113020': '317', '113090': '317',
      '114020': '317', '115020': '317',
    },
    papersByCC: {
      '101': [
        { s: '0101', subject: '中醫基礎醫學(一)' }, { s: '0102', subject: '中醫基礎醫學(二)' },
      ],
      '317': [
        { s: '0101', subject: '中醫基礎醫學(一)' }, { s: '0102', subject: '中醫基礎醫學(二)' },
      ],
    },
  },
  'questions-tcm2.json': {
    prefix: 'tcm2',
    classCodeBySession: {
      '106030': '102', '106110': '102', '107030': '102', '107110': '102',
      '108020': '102', '108110': '102', '109030': '102', '109110': '102',
      '110030': '102', '110111': '102',
      '111030': '102', '111110': '102',
      '112020': '318', '112090': '318', '113020': '318', '113090': '318',
      '114020': '318', '115020': '318',
    },
    papersByCC: {
      '102': [
        { s: '0103', subject: '中醫臨床醫學(一)' }, { s: '0104', subject: '中醫臨床醫學(二)' },
        { s: '0105', subject: '中醫臨床醫學(三)' }, { s: '0106', subject: '中醫臨床醫學(四)' },
      ],
      '318': [
        { s: '0103', subject: '中醫臨床醫學(一)' }, { s: '0104', subject: '中醫臨床醫學(二)' },
        { s: '0105', subject: '中醫臨床醫學(三)' }, { s: '0106', subject: '中醫臨床醫學(四)' },
      ],
    },
  },
  'questions-vet.json': {
    prefix: 'vet',
    classCodeBySession: {
      '106020': '314', '106100': '314', '107020': '314', '107100': '314',
      '108030': '314', '108100': '314', '109020': '314', '109100': '314',
      '110100': '314', '111100': '314', '112100': '314', '113090': '314',
      '114090': '314',
    },
    papersByCC: {
      '314': [
        { s: '11', subject: '獸醫病理學' }, { s: '22', subject: '獸醫藥理學' },
        { s: '33', subject: '獸醫實驗診斷學' }, { s: '44', subject: '獸醫普通疾病學' },
        { s: '55', subject: '獸醫傳染病學' }, { s: '66', subject: '獸醫公共衛生學' },
      ],
    },
  },
  'questions-social-worker.json': {
    prefix: 'social-worker',
    classCodeBySession: {
      '106030': '107', '106110': '107', '107030': '107', '108110': '107',
      '109030': '107', '113030': '107', '115030': '107',
    },
    papersByCC: {
      '107': [
        { s: '0601', subject: '社會工作' }, { s: '0602', subject: '社會工作直接服務' },
        { s: '0603', subject: '社會工作管理' },
      ],
    },
  },
}

function findCachedPdf(prefix, examCode, cc, subjectCode) {
  const patterns = [
    `${prefix}_${examCode}_c${cc}_s${subjectCode}`,
    `${prefix}_Q_${examCode}_c${cc}_s${subjectCode}`,
  ]
  for (const dir of CACHE_DIRS) {
    const base = path.join(BACKEND, dir)
    if (!fs.existsSync(base)) continue
    for (const pattern of patterns) {
      const exact = path.join(base, pattern + '.pdf')
      if (fs.existsSync(exact)) return fs.readFileSync(exact)
    }
    // Partial match
    for (const f of fs.readdirSync(base)) {
      if (!f.endsWith('.pdf')) continue
      for (const pattern of patterns) {
        if (f.includes(pattern)) return fs.readFileSync(path.join(base, f))
      }
      // Also match patterns like nursing_107第二次_Q_107110_c104_s0303
      if (f.includes(`_Q_${examCode}_c${cc}_s${subjectCode}`)) {
        return fs.readFileSync(path.join(base, f))
      }
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

// Parse MCQ from positional data (mixed essay+MCQ format)
function parseQuestionsFromPositional(items) {
  // Skip to MCQ section (if present)
  const mcqIdx = items.findIndex(it =>
    it.str.includes('測驗題部分') || it.str.includes('測驗題')
  )
  const mcqItems = mcqIdx >= 0 ? items.slice(mcqIdx) : items
  const rows = groupIntoRows(mcqItems)

  // Find question starts (number at x < 60)
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

      // Check if stem line (contains question mark / long text at left margin)
      const rowText = nonEmpty.map(r => r.str).join('').trim()
      const isStemLike = (rowText.includes('？') || rowText.includes('：') || rowText.includes('?')) && optionRows.length === 0

      if (isStemLike) {
        stemParts.push(rowText)
      } else if (xSpread > 100 && nonEmpty.length >= 2) {
        optionRows.push(nonEmpty)
      } else if (optionRows.length > 0) {
        optionRows.push(nonEmpty)
      } else if (stemParts.length > 0 && nonEmpty.length === 1 && nonEmpty[0].x >= 65 && nonEmpty[0].x <= 90) {
        // After stem, single-indent lines are options (nursing one-per-line format)
        optionRows.push(nonEmpty)
      } else {
        stemParts.push(rowText)
      }
    }

    // Parse options
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
      questions[num] = {
        question: stripPUA(stemParts.join(' ')),
        options,
      }
    }
  }
  return questions
}

async function main() {
  const files = Object.keys(EXAM_DEFS)
  let grandFixed = 0, grandSkipped = 0

  for (const fileName of files) {
    const def = EXAM_DEFS[fileName]
    if (examFilter) {
      const examId = fileName.replace('questions-', '').replace('.json', '')
      if (examId !== examFilter) continue
    }

    const filePath = path.join(BACKEND, fileName)
    if (!fs.existsSync(filePath)) continue
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const qs = data.questions || data
    if (!Array.isArray(qs)) continue

    // Find broken (partial empty)
    const broken = qs.filter(q => {
      const vals = ['A', 'B', 'C', 'D'].map(k => (q.options[k] || '').trim())
      return vals.filter(v => !v).length > 0 && vals.filter(v => v).length > 0
    })
    if (broken.length === 0) { continue }

    console.log(`\n📋 ${fileName}: ${broken.length} 題有空選項`)

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
      const cc = def.classCodeBySession[examCode]
      if (!cc) {
        console.log(`  ⚠ ${examCode} ${subject}: 無 class code`)
        grandSkipped += groupQs.length
        continue
      }
      const papers = def.papersByCC[cc]
      if (!papers) {
        console.log(`  ⚠ ${examCode} ${subject}: 無 papers (cc=${cc})`)
        grandSkipped += groupQs.length
        continue
      }
      const paper = papers.find(p => p.subject === subject || subject.includes(p.subject) || p.subject.includes(subject))
      if (!paper) {
        console.log(`  ⚠ ${examCode} ${subject}: 無 subject code`)
        grandSkipped += groupQs.length
        continue
      }

      const buf = findCachedPdf(def.prefix, examCode, cc, paper.s)
      if (!buf) {
        console.log(`  ⚠ ${examCode} ${subject}: 無快取 PDF`)
        grandSkipped += groupQs.length
        continue
      }

      let parsed
      try {
        const items = await extractPositionedText(buf)
        parsed = parseQuestionsFromPositional(items)
      } catch (e) {
        console.log(`  ⚠ ${examCode} ${subject}: 解析失敗: ${e.message}`)
        grandSkipped += groupQs.length
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
        const newQ = (p.question || '').trim()
        if (newQ && newQ.length > (q.question || '').length) {
          if (!DRY_RUN) q.question = newQ
          changed = true
        }
        if (changed) groupFixed++
      }
      const status = groupFixed > 0 ? '✓' : '⚠'
      console.log(`  ${status} ${examCode} ${subject}: ${groupFixed}/${groupQs.length}`)
      fileFixed += groupFixed
      grandSkipped += groupQs.length - groupFixed
    }

    if (!DRY_RUN && fileFixed > 0) {
      if (!Array.isArray(data)) data.total = (data.questions || []).length
      const tmp = filePath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
      fs.renameSync(tmp, filePath)
    }
    grandFixed += fileFixed
    console.log(`  → ${fileName}: ${fileFixed} 修復`)
  }

  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}總計: ${grandFixed} 修復, ${grandSkipped} 跳過`)
}

main().catch(e => { console.error(e); process.exit(1) })
