#!/usr/bin/env node
/**
 * Fix first-character truncation in doctor1/doctor2 106-109年 new-format PDFs.
 *
 * Root cause: when a question option's text starts with the same letter as
 * the option marker (e.g. option A text = "Acetaminophen" → scraper sees
 * "A" as a new option-A marker, overwrites the real option A content).
 *
 * Strategy:
 *   - Scan for near-duplicate options (one = other minus first char)
 *   - For each affected (exam_code, subject), use cached PDFs from fix-truncated-questions
 *   - Extract options using pdfjs positional extraction:
 *       A./B./C./D. labels at x≈39, content items in y-range between labels
 *   - Update both questions.json and questions-doctor2.json
 *
 * Usage:
 *   node scripts/fix-first-char-truncation.js             # fix all
 *   node scripts/fix-first-char-truncation.js --dry       # dry run
 *   node scripts/fix-first-char-truncation.js --debug 106100_醫學二_9  # show Q details
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs   = require('fs')
const path = require('path')
const https = require('https')
const pdfjsLib = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')

const BACKEND = path.resolve(__dirname, '..')
const CACHE   = path.join(BACKEND, '_tmp', 'pdf-cache')
const DRY     = process.argv.includes('--dry')
const DEBUG   = process.argv.find(a => a.startsWith('--debug '))?.slice(8)
  || (process.argv.indexOf('--debug') !== -1 ? process.argv[process.argv.indexOf('--debug') + 1] : null)

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'

// Subject → subject code mapping (confirmed from previous probe sessions)
// doctor1 (c=301): 醫學(一)=s11 or s55, 醫學(二)=s22 or s66  depending on series
// doctor2 (c=302): 醫學(三)=s11, 醫學(四)=s22, 醫學(五)=s33, 醫學(六)=s44
const SUBJECT_CODES = {
  doctor1: { '醫學(一)': ['11', '55'], '醫學(二)': ['22', '66'] },
  doctor2: { '醫學(三)': ['11'], '醫學(四)': ['22'], '醫學(五)': ['33'], '醫學(六)': ['44'] },
}

function examToFile(examTag) {
  return examTag === 'doctor1' ? 'questions.json' : 'questions-doctor2.json'
}
function examToClass(examTag) {
  return examTag === 'doctor1' ? '301' : '302'
}

// ─── Near-dup detection ───────────────────────────────────────────────────────

const SKIP_INTENTIONAL = ['交感', '副交感', '交叉', '順時', '逆時', '增生，不肥大', '可預見', '不可預見', '因過失', '非因過失']

function findNearDups(q) {
  if (!q.options) return []
  const keys = ['A', 'B', 'C', 'D']
  const vals = keys.map(k => q.options[k] || '')
  const truncated = new Set()

  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      if (i === j) continue
      const a = vals[i], b = vals[j]
      if (a.length >= 3 && b.length >= 4 && a === b.slice(1)) {
        if (SKIP_INTENTIONAL.some(s => a.includes(s) || b.includes(s))) continue
        truncated.add(keys[i])
      }
    }
  }

  // Bracket fragments
  for (const k of keys) {
    const v = q.options[k] || ''
    if (v.match(/^[）\)]/)) truncated.add(k)
  }

  return [...truncated]
}

// ─── PDF fetch & cache ────────────────────────────────────────────────────────

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 30000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*',
                 Referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location
        if (!loc || !loc.startsWith('http')) { res.resume(); return reject(new Error('bad redirect')) }
        return fetchPdf(loc, retries).then(resolve, reject)
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
      const cs = []; res.on('data', c => cs.push(c)); res.on('end', () => resolve(Buffer.concat(cs)))
      res.on('error', reject)
    })
    req.on('error', e => retries > 0
      ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 1000)
      : reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function getCachedPdf(examTag, code, c, s) {
  const key  = `${examTag}_${code}_c${c}_s${s}.pdf`
  const file = path.join(CACHE, key)
  if (fs.existsSync(file) && fs.statSync(file).size > 5000) return fs.readFileSync(file)
  const url = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
  console.log('  [fetch]', url)
  const buf = await fetchPdf(url)
  fs.mkdirSync(CACHE, { recursive: true })
  fs.writeFileSync(file, buf)
  return buf
}

// ─── pdfjs option extraction ──────────────────────────────────────────────────

async function extractItems(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const items = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    for (const it of content.items) {
      const s = it.str.trim()
      if (!s) continue
      items.push({ x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), str: s, page: p })
    }
  }
  items.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)
  return items
}

// Parse all questions and their options from pdfjs items (new format: A./B./C./D. labels)
function parseAllQuestions(items) {
  // Find question number anchors (short number. item at x < 40)
  const anchors = []
  const seen = new Set()
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.x > 40) continue
    const m = it.str.match(/^(\d{1,3})[.、．]?$/)
    if (!m) continue
    const n = +m[1]
    if (n < 1 || n > 120 || seen.has(n)) continue
    // Reject header rows: check only items within ±2 (tight) to avoid superscripts at ±3-4
    // interfering. A true header row has "年第" etc., or adjacent question text starting with digit.
    const rowItems = items.filter(o => o.page === it.page && Math.abs(o.y - it.y) <= 2 && o !== it)
    if (rowItems.length >= 1 && rowItems[0].x > 45 && /^\d{2,}/.test(rowItems[0]?.str || '')) continue
    seen.add(n)
    anchors.push({ num: n, y: it.y, page: it.page, idx: i })
  }
  anchors.sort((a, b) => a.num - b.num)

  const result = {}
  const LABEL_BAND = 6  // pdfjs renders label dot and text on slightly different baselines

  for (let ai = 0; ai < anchors.length; ai++) {
    const anchor = anchors[ai]
    const nextAnchor = anchors[ai + 1]

    // Items in this question's block (from anchor to next anchor)
    const blockItems = items.filter(it => {
      if (it.page < anchor.page) return false
      if (nextAnchor) {
        if (it.page > nextAnchor.page) return false
        if (it.page === nextAnchor.page && it.y < nextAnchor.y - 2) return false
      }
      if (it.page === anchor.page && it.y > anchor.y + 2) return false
      return true
    })

    // Find A./B./C./D. label items (x < 45, str is exactly A./B./C./D.)
    const labels = {}
    for (const it of blockItems) {
      if (it.x > 45) continue
      const m = it.str.match(/^([A-D])[.．]$/)
      if (m) labels[m[1]] = { y: it.y, page: it.page }
    }

    if (Object.keys(labels).length < 2) continue

    // Sort label positions top-to-bottom (descending y)
    const labelOrder = Object.entries(labels).sort((a, b) => b[1].y - a[1].y)

    const opts = {}
    for (let li = 0; li < labelOrder.length; li++) {
      const [key, pos] = labelOrder[li]
      const nextLabel = labelOrder[li + 1]

      // Collect content items for this option:
      //   1. Items on the same row as this label (±LABEL_BAND): handles "label and content
      //      rendered at slightly different baselines on the same visual line"
      //   2. Items strictly between this label's row and the next label's row (multi-line content)
      const contentItems = blockItems.filter(it => {
        if (it.page !== pos.page) return false
        if (it.x <= 45 && it.str.match(/^[A-D][.．]$/)) return false  // skip option labels

        // Zone 1: same row as this label (content sitting next to the label)
        if (Math.abs(it.y - pos.y) <= LABEL_BAND) return true

        // Zone 2: between this label and next label (multi-line wrapped content)
        if (nextLabel && nextLabel[1].page === pos.page) {
          const low = nextLabel[1].y + LABEL_BAND + 1
          const high = pos.y - LABEL_BAND - 1
          if (low <= high && it.y >= low && it.y <= high) return true
        }

        return false
      })
      contentItems.sort((a, b) => b.y - a.y || a.x - b.x)

      // Group by row (same y ±3), join within each row, then join rows
      const rowGroups = []
      for (const it of contentItems) {
        const last = rowGroups[rowGroups.length - 1]
        if (last && Math.abs(last.y - it.y) <= 3) last.parts.push(it.str)
        else rowGroups.push({ y: it.y, parts: [it.str] })
      }
      const optText = rowGroups.map(g => g.parts.join('')).join('').trim()
      if (optText) opts[key] = optText
    }

    if (Object.keys(opts).length >= 2) result[anchor.num] = opts
  }

  return result
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Load both JSON files
  const files = {
    doctor1: JSON.parse(fs.readFileSync(path.join(BACKEND, 'questions.json'), 'utf8')),
    doctor2: JSON.parse(fs.readFileSync(path.join(BACKEND, 'questions-doctor2.json'), 'utf8')),
  }

  // Scan for affected questions (106-109年only)
  const byGroup = {}  // key = 'examTag|exam_code|subject' → {examTag, code, subject, questions:[q]}
  for (const [examTag, data] of Object.entries(files)) {
    const qs = data.questions
    for (const q of qs) {
      const year = parseInt(q.roc_year || q.exam_code?.substring(0, 3) || 0)
      if (year < 106 || year > 109) continue
      const dups = findNearDups(q)
      if (!dups.length) continue
      const key = `${examTag}|${q.exam_code}|${q.subject}`
      if (!byGroup[key]) byGroup[key] = { examTag, code: q.exam_code, subject: q.subject, questions: [] }
      byGroup[key].questions.push({ q, dups })
    }
  }

  console.log(`Found ${Object.keys(byGroup).length} (exam_code, subject) groups with issues`)

  let totalFixed = 0

  for (const [groupKey, group] of Object.entries(byGroup)) {
    const { examTag, code, subject } = group
    const subjectCodes = SUBJECT_CODES[examTag]?.[subject]
    if (!subjectCodes) {
      console.warn(`SKIP: no subject code mapping for ${examTag} ${subject}`)
      continue
    }

    const classCode = examToClass(examTag)
    console.log(`\n=== ${examTag} ${code} ${subject} (${group.questions.length} affected) ===`)

    // Try each possible subject code until we get a valid PDF
    let parsedQuestions = null
    let usedS = null

    for (const s of subjectCodes) {
      try {
        const buf = await getCachedPdf(examTag, code, classCode, s)
        if (buf.length < 5000) continue

        // Verify exam name from first 200 chars of text
        const pdfParse = require('pdf-parse')
        const preview = await pdfParse(buf, { max: 1 })
        const previewText = (preview.text || '').substring(0, 200)
        const isDoctor1 = /醫師（一階）|醫師.一/.test(previewText)
        const isDoctor2 = /醫師（二階）|醫師.二/.test(previewText)
        if (examTag === 'doctor1' && !isDoctor1 && isDoctor2) {
          console.log(`  s=${s}: wrong exam (got doctor2 PDF), skip`)
          continue
        }
        if (examTag === 'doctor2' && !isDoctor2 && isDoctor1) {
          console.log(`  s=${s}: wrong exam (got doctor1 PDF), skip`)
          continue
        }

        const items = await extractItems(buf)
        parsedQuestions = parseAllQuestions(items)
        usedS = s
        console.log(`  s=${s}: parsed ${Object.keys(parsedQuestions).length} questions`)
        break
      } catch (e) {
        console.log(`  s=${s}: ${e.message}`)
      }
    }

    if (!parsedQuestions) {
      console.warn(`  SKIP: could not download/parse PDF for ${code} ${subject}`)
      continue
    }

    const qs = files[examTag].questions

    for (const { q, dups } of group.questions) {
      const pdfQ = parsedQuestions[q.number]
      if (!pdfQ) {
        console.warn(`  Q${q.number}: not found in PDF (parsed ${Object.keys(parsedQuestions).join(',')})`)
        continue
      }

      if (DEBUG) {
        const dbgKey = `${code}_${subject.replace(/[()（）]/g, '')}_${q.number}`
        if (DEBUG.includes(q.number.toString()) || dbgKey === DEBUG) {
          console.log(`\n  [DEBUG] Q${q.number}`)
          console.log('    PDF opts:', JSON.stringify(pdfQ))
          console.log('    Current:', JSON.stringify(q.options))
          console.log('    Truncated keys:', dups)
        }
      }

      // Validate: PDF must have at least 2 options and no duplicate vals
      const pdfVals = ['A', 'B', 'C', 'D'].map(k => pdfQ[k] || '')
      const nonEmpty = pdfVals.filter(v => v.length > 0)
      if (nonEmpty.length < 2) {
        console.warn(`  SKIP Q${q.number}: PDF extracted only ${nonEmpty.length} options`)
        continue
      }
      const uniqueVals = new Set(nonEmpty)
      if (uniqueVals.size < nonEmpty.length) {
        console.warn(`  SKIP Q${q.number}: PDF extracted duplicate options: ${pdfVals.join('|')}`)
        continue
      }

      // Check that PDF options differ from current truncated options in expected way
      let willFix = false
      for (const k of dups) {
        const pdfOpt = pdfQ[k]
        const curOpt = q.options[k] || ''
        if (!pdfOpt) {
          console.warn(`  Q${q.number} ${k}: PDF missing option`)
          continue
        }
        if (pdfOpt === curOpt) {
          // Already correct
          continue
        }
        willFix = true
        console.log(`  Q${q.number} ${k}: '${curOpt.substring(0, 40)}' → '${pdfOpt.substring(0, 40)}'`)
      }

      if (!willFix) continue

      if (!DRY) {
        // Replace ALL 4 options with PDF-extracted values (for consistency)
        for (const k of ['A', 'B', 'C', 'D']) {
          if (pdfQ[k]) q.options[k] = pdfQ[k]
        }
        totalFixed++
      } else {
        totalFixed++
      }
    }
  }

  if (!DRY) {
    for (const [examTag, data] of Object.entries(files)) {
      const file = examToFile(examTag)
      const filePath = path.join(BACKEND, file)
      data.metadata.last_updated = new Date().toISOString()
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
      console.log(`\nWrote ${file}`)
    }
    console.log(`\nTotal questions fixed: ${totalFixed}`)
  } else {
    console.log(`\n[DRY] Would fix ${totalFixed} questions`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
