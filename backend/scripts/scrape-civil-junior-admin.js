#!/usr/bin/env node
// Scrape 普通考試（四等）行政法概要 + 行政學概要 into shared banks.
// Pure MCQ papers (50Q each), c=401, session codes verified 2026-04-23.
//
// Usage:
//   node scripts/scrape-civil-junior-admin.js                  # all years
//   node scripts/scrape-civil-junior-admin.js --year 114        # single year
//   node scripts/scrape-civil-junior-admin.js --dry-run
//   node scripts/scrape-civil-junior-admin.js --bank admin_law  # one bank only

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfjsLib = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')
const pdfParse = require('pdf-parse')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const BANKS_DIR = path.join(__dirname, '..', 'shared-banks')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const yearFilter = args.find((_, i) => args[i - 1] === '--year') || null
const bankFilter = args.find((_, i) => args[i - 1] === '--bank') || null

// Year → session code (same as civil-senior / shared-banks scraper)
const SESSIONS = [
  { year: '106', code: '106090', session: '第一次' },
  { year: '107', code: '107090', session: '第一次' },
  { year: '108', code: '108090', session: '第一次' },
  { year: '109', code: '109090', session: '第一次' },
  { year: '110', code: '110090', session: '第一次' },
  { year: '111', code: '111090', session: '第一次' },
  { year: '112', code: '112090', session: '第一次' },
  { year: '113', code: '113080', session: '第一次' },
  { year: '114', code: '114080', session: '第一次' },
]

// s-codes verified by probing MoEX 2026-04-23
const SUBJECTS = [
  // 行政學概要 (50Q MCQ)
  { c: '401', s: '0505', bank: 'admin_studies', name: '行政學概要', tag: 'admin_studies', onlyYears: ['106'] },
  { c: '401', s: '0608', bank: 'admin_studies', name: '行政學概要', tag: 'admin_studies', onlyYears: ['107', '108'] },
  { c: '401', s: '0605', bank: 'admin_studies', name: '行政學概要', tag: 'admin_studies', onlyYears: ['109'] },
  { c: '401', s: '0502', bank: 'admin_studies', name: '行政學概要', tag: 'admin_studies', onlyYears: ['110'] },
  { c: '401', s: '0302', bank: 'admin_studies', name: '行政學概要', tag: 'admin_studies', onlyYears: ['111', '112'] },
  { c: '401', s: '0304', bank: 'admin_studies', name: '行政學概要', tag: 'admin_studies', onlyYears: ['113', '114'] },
  // 行政法概要 (50Q MCQ)
  { c: '401', s: '0705', bank: 'admin_law', name: '行政法概要', tag: 'admin_law', onlyYears: ['106'] },
  { c: '401', s: '0804', bank: 'admin_law', name: '行政法概要', tag: 'admin_law', onlyYears: ['107', '108', '109'] },
  { c: '401', s: '0606', bank: 'admin_law', name: '行政法概要', tag: 'admin_law', onlyYears: ['110'] },
  { c: '401', s: '0406', bank: 'admin_law', name: '行政法概要', tag: 'admin_law', onlyYears: ['111', '112', '113', '114'] },
]

const BANK_META = {
  admin_law: {
    bankId: 'common_admin_law_junior',
    name: '普通考試 行政法概要',
    description: '公務人員普通考試（四等）行政法概要，106–114 年，每年 50 題選擇題。',
    file: 'common_admin_law_junior.json',
  },
  admin_studies: {
    bankId: 'common_admin_studies_junior',
    name: '普通考試 行政學概要',
    description: '公務人員普通考試（四等）行政學概要，106–114 年，每年 50 題選擇題。',
    file: 'common_admin_studies_junior.json',
  },
}

// ─── PDF fetch ───────────────────────────────────────────────
function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 25000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*',
                 Referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume()
        if (retries > 0) return setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800)
        return reject(new Error('redirect'))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error('HTTP ' + res.statusCode))
      }
      const ct = res.headers['content-type'] || ''
      if (!ct.includes('pdf') && !ct.includes('octet')) { res.resume(); return reject(new Error('not PDF')) }
      const cs = []
      res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    })
    req.on('error', e => retries > 0 ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 800) : reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

// ─── PDF name validation ──────────────────────────────────────
async function validatePdfName(buf, year) {
  const { text } = await pdfParse(buf)
  const excerpt = text.slice(0, 300)
  if (!excerpt.includes('普通考試')) {
    throw new Error('PDF 類科名稱不符：期望「普通考試」，實際：' + excerpt.slice(0, 80))
  }
}

// ─── PUA decoding (for 106-107 era PDFs) ─────────────────────
function decodePUA(s) {
  if (s.length !== 1) return s
  const code = s.charCodeAt(0)
  if (code >= 0xE0C6 && code <= 0xE0CF) return String(code - 0xE0C6 + 1)
  if (code >= 0xE000 && code <= 0xF8FF) return ''
  return s
}

async function extractPositionedText(buf) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const allItems = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    for (const item of content.items) {
      const s = decodePUA(item.str)
      if (!s.trim()) continue
      allItems.push({ x: Math.round(item.transform[4]), y: Math.round(item.transform[5]), page: p, str: s })
    }
  }
  allItems.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)
  return allItems
}

function buildLogicalLines(items) {
  const rows = []
  let currentY = null, currentRow = []
  for (const item of items) {
    if (currentY === null || Math.abs(item.y - currentY) > 3) {
      if (currentRow.length) rows.push(currentRow)
      currentRow = [item]
      currentY = item.y
    } else {
      currentRow.push(item)
    }
  }
  if (currentRow.length) rows.push(currentRow)

  const lines = []
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x)
    const gapIdxs = []
    for (let i = 1; i < row.length; i++) {
      const prevEnd = row[i - 1].x + row[i - 1].str.length * 11
      if (row[i].x - prevEnd > 30 || row[i].x - row[i - 1].x > 80) gapIdxs.push(i)
    }
    if (gapIdxs.length >= 3) {
      const breaks = [0, ...gapIdxs, row.length]
      for (let b = 0; b < breaks.length - 1; b++) {
        const chunk = row.slice(breaks[b], breaks[b + 1])
        const text = chunk.map(r => r.str).join('').trim()
        if (text) lines.push({ text, x: chunk[0].x, y: row[0].y, col: 'C' + b })
      }
    } else if (gapIdxs.length >= 1) {
      const left = row.slice(0, gapIdxs[0]).map(r => r.str).join('').trim()
      const right = row.slice(gapIdxs[0]).map(r => r.str).join('').trim()
      if (left) lines.push({ text: left, x: row[0].x, y: row[0].y, col: 'L' })
      if (right) lines.push({ text: right, x: row[gapIdxs[0]].x, y: row[0].y, col: 'R' })
    } else {
      const text = row.map(r => r.str).join('').trim()
      if (text) lines.push({ text, x: row[0].x, y: row[0].y, col: 'F' })
    }
  }
  return lines
}

function extractOptions(items) {
  if (items.length === 0) return []
  const yGroups = []
  let curY = null, curGroup = []
  for (const item of items) {
    if (curY === null || Math.abs(item.y - curY) > 3) {
      if (curGroup.length) yGroups.push(curGroup)
      curGroup = [item]
      curY = item.y
    } else {
      curGroup.push(item)
    }
  }
  if (curGroup.length) yGroups.push(curGroup)

  const opts = []
  for (const group of yGroups) {
    group.sort((a, b) => a.x - b.x)
    const colTypes = new Set(group.map(it => it.col))
    if (colTypes.has('C0') || colTypes.has('C1') || colTypes.has('C2') || colTypes.has('C3')) {
      for (const item of group) opts.push(item.text)
    } else if (colTypes.has('L') && colTypes.has('R')) {
      const left = group.filter(it => it.col === 'L').map(it => it.text).join('')
      const right = group.filter(it => it.col === 'R').map(it => it.text).join('')
      opts.push(left)
      opts.push(right)
    } else {
      const fullText = group.map(it => it.text).join('')
      if (opts.length > 0 && group[0].x > 65 && group[0].col === 'F' && fullText.length < 6) {
        opts[opts.length - 1] += fullText
      } else {
        opts.push(fullText)
      }
    }
  }
  return opts
}

function parseQuestions(lines) {
  const filtered = lines.filter(l => {
    const t = l.text
    if (/^(代號|類\s*科|科\s*目|考試|頁次|等\s*別|本試題|座號|※|禁止|本科目|須用|共\d+題)/.test(t)) return false
    if (/^\d+－\d+$/.test(t)) return false
    if (/^\d{3,4}年/.test(t)) return false
    return true
  })

  const qStarts = []
  let expectNext = 1
  for (let i = 0; i < filtered.length; i++) {
    const line = filtered[i]
    if (line.x > 95) continue
    const es = String(expectNext)
    if (line.text.startsWith(es)) {
      const rest = line.text.slice(es.length)
      if (rest.length === 0) continue
      const fullNum = parseInt(line.text.match(/^(\d+)/)[1])
      if (/^年\s*(第|公務|專門|國家|特種)/.test(rest)) continue
      if (fullNum !== expectNext && fullNum > expectNext) { /* accept as-is */ }
      qStarts.push({ idx: i, number: expectNext })
      expectNext++
    }
  }

  const questions = []
  for (let qi = 0; qi < qStarts.length; qi++) {
    const start = qStarts[qi].idx
    const end = qi + 1 < qStarts.length ? qStarts[qi + 1].idx : filtered.length
    const num = qStarts[qi].number
    const block = filtered.slice(start, end)

    let stemText = block[0].text.slice(String(num).length).trim()
    stemText = stemText.replace(new RegExp('^\\.\\s*' + num + '\\s*'), '')
    const restItems = block.slice(1)

    let stemEndIdx = 0
    let stemEnded = stemText.includes('？') || stemText.includes('：')
    if (!stemEnded) {
      for (let ri = 0; ri < restItems.length; ri++) {
        if (restItems[ri].text.includes('？') || restItems[ri].text.includes('：')) {
          stemEndIdx = ri + 1
          stemEnded = true
          break
        }
      }
    }

    const stemParts = [stemText]
    for (let ri = 0; ri < stemEndIdx; ri++) stemParts.push(restItems[ri].text)
    const optionItems = restItems.slice(stemEndIdx)
    const opts = extractOptions(optionItems)

    if (opts.length >= 2) {
      const options = {}
      const labels = ['A', 'B', 'C', 'D']
      for (let oi = 0; oi < Math.min(opts.length, 4); oi++) options[labels[oi]] = opts[oi]
      questions.push({ number: num, question: stemParts.join(' ').trim(), options })
    }
  }
  return questions
}

async function parseAnswers(buf) {
  const { text } = await pdfParse(buf)
  const answers = {}
  const fw = /答案\s*([ＡＢＣＤ]+)/g
  let m, n = 1
  while ((m = fw.exec(text)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) answers[n++] = k
    }
  }
  if (Object.keys(answers).length >= 5) return answers
  let cleaned = text.replace(/第\d{1,3}題/g, '').replace(/題號/g, '').replace(/答案/g, '')
    .replace(/標準/g, '').replace(/[\s\n\r]+/g, '')
  let idx = 1
  for (const ch of cleaned) {
    if (ch === 'A' || ch === 'B' || ch === 'C' || ch === 'D') answers[idx++] = ch
  }
  return answers
}

function loadBank(meta) {
  const p = path.join(BANKS_DIR, meta.file)
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { /* fall through */ }
  }
  return {
    bankId: meta.bankId,
    name: meta.name,
    description: meta.description,
    bankVersion: '1',
    last_synced_at: new Date().toISOString(),
    levels: ['junior'],
    questions: [],
  }
}

function saveBank(meta, data) {
  const p = path.join(BANKS_DIR, meta.file)
  const tmp = p + '.tmp'
  data.last_synced_at = new Date().toISOString()
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, p)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const banks = { admin_law: loadBank(BANK_META.admin_law), admin_studies: loadBank(BANK_META.admin_studies) }

  let totalAdded = 0

  for (const sess of SESSIONS) {
    if (yearFilter && sess.year !== yearFilter) continue
    console.log(`\n=== ${sess.year} (${sess.code}) ===`)

    for (const sub of SUBJECTS) {
      if (sub.onlyYears && !sub.onlyYears.includes(sess.year)) continue
      if (bankFilter && sub.bank !== bankFilter) continue

      const bankId = BANK_META[sub.bank].bankId
      const bank = banks[sub.bank]

      // Check if already scraped
      const existingKey = new Set(bank.questions.map(q => `${q.roc_year}-${q.number}`))
      if (existingKey.has(`${sess.year}-1`) && existingKey.has(`${sess.year}-50`)) {
        console.log(`  ⏭  ${sub.name} ${sess.year}: already present`)
        continue
      }

      const qUrl = `${BASE}?t=Q&code=${sess.code}&c=${sub.c}&s=${sub.s}&q=1`
      const aUrl = `${BASE}?t=S&code=${sess.code}&c=${sub.c}&s=${sub.s}&q=1`

      console.log(`  ▶ ${sub.name} (c=${sub.c} s=${sub.s})`)

      if (dryRun) {
        console.log(`    [dry-run] Q: ${qUrl}`)
        continue
      }

      let qBuf, aBuf
      try { qBuf = await fetchPdf(qUrl) } catch (e) { console.log(`    ✗ Q PDF: ${e.message}`); continue }
      try { aBuf = await fetchPdf(aUrl) } catch (e) { console.log(`    ⚠ A PDF: ${e.message}`); aBuf = null }

      // Validate PDF name
      try { await validatePdfName(qBuf, sess.year) } catch (e) { console.log(`    ✗ ${e.message}`); continue }

      const items = await extractPositionedText(qBuf)
      const lines = buildLogicalLines(items)
      const qs = parseQuestions(lines)
      console.log(`    ↳ ${qs.length} questions parsed`)

      if (qs.length < 40) {
        console.log(`    ✗ Too few questions (${qs.length}), skipping`)
        continue
      }

      let answers = {}
      if (aBuf) {
        answers = await parseAnswers(aBuf)
        console.log(`    ↳ ${Object.keys(answers).length} answers parsed`)
      }

      // Remove any existing entries for this year (re-scrape)
      const before = bank.questions.length
      bank.questions = bank.questions.filter(q => !(q.roc_year === sess.year && q.source_exam_code === 'civil-junior-general'))

      let added = 0
      for (const q of qs) {
        const answer = answers[q.number] || null
        bank.questions.push({
          id: `${bankId}-${sess.year}-civil-junior-${q.number}`,
          roc_year: sess.year,
          session: sess.session,
          source_exam_code: 'civil-junior-general',
          source_exam_name: 'civil-junior-general',
          subject: sub.name,
          subject_tags: [sub.tag],
          number: q.number,
          question: q.question,
          options: q.options,
          answer,
          level: 'junior',
          shared_bank: bankId,
          parent_id: null,
          case_context: null,
          is_deprecated: false,
          deprecated_reason: null,
        })
        added++
      }

      console.log(`    ✓ Added ${added} questions (bank: ${bank.questions.length} total)`)
      totalAdded += added

      saveBank(BANK_META[sub.bank], bank)
      await sleep(600)
    }
  }

  // Final save for both banks
  if (!dryRun) {
    for (const [key, meta] of Object.entries(BANK_META)) {
      if (!bankFilter || bankFilter === key) saveBank(meta, banks[key])
    }
  }

  console.log(`\n✅ Done — ${totalAdded} questions added total`)
  console.log(`   admin_law_junior: ${banks.admin_law.questions.length} q`)
  console.log(`   admin_studies_junior: ${banks.admin_studies.questions.length} q`)
}

main().catch(e => { console.error(e); process.exit(1) })
