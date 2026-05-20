#!/usr/bin/env node
// Fill Q1-9 / Q12 / Q15 gaps in common_politics 106 & 107.
// The mupdf column parser misses PUA-encoded single-digit question numbers in
// 106-107 era PDFs; this uses pdfjs position data + decodePUA (same as
// scrape-civil-senior.js) to recover the missing rows.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfjsLib = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')
const pdfParse = require('pdf-parse')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'

// Recoverable PUA / column-parser gaps for civil junior 概要 banks.
// Select with --bank <id>; defaults to common_politics.
// pdfjs decodePUA recovers single-digit / dropped question numbers; only
// missing question numbers get added (existing ids skipped).
const CONFIGS = {
  common_politics: {
    subject: '政治學概要', sourceCode: 'civil-junior-general', tag: 'politics',
    sourceName: y => `${y} 年普通考試一般行政`,
    targets: [
      { year: '102', code: '102090', c: '401', s: '0407' },
      { year: '103', code: '103080', c: '401', s: '0407' },
      { year: '105', code: '105080', c: '401', s: '0507' },
      { year: '106', code: '106090', c: '401', s: '0507' },
      { year: '107', code: '107090', c: '401', s: '0610' },
    ],
  },
  common_local_gov: {
    subject: '地方自治概要', sourceCode: 'civil-junior-civil-affairs', tag: 'local_gov',
    sourceName: y => `${y} 年普通考試一般民政`,
    targets: [
      { year: '104', code: '104080', c: '402', s: '0409' },
      { year: '105', code: '105080', c: '402', s: '0509' },
      { year: '106', code: '106090', c: '402', s: '0509' },
      { year: '107', code: '107090', c: '402', s: '0612' },
    ],
  },
  common_public_mgmt: {
    subject: '公共管理概要', sourceCode: 'civil-junior-general', tag: 'public_management',
    sourceName: y => `${y} 年普通考試一般行政`,
    targets: [
      { year: '105', code: '105080', c: '401', s: '0503' },
      { year: '106', code: '106090', c: '401', s: '0503' },
      { year: '107', code: '107090', c: '401', s: '0606' },
      { year: '110', code: '110090', c: '401', s: '0504' },
      { year: '111', code: '111090', c: '401', s: '0304' },
    ],
  },
  // idCode: 既有 106-114 資料 id 用 `civil-junior` 區段（source_exam_code 欄位卻是
  // `civil-junior-general`）。idCode 讓補題的 id 與既有方案一致，避免重複列。
  common_admin_studies_junior: {
    subject: '行政學概要', sourceCode: 'civil-junior-general', idCode: 'civil-junior', tag: 'admin_studies',
    sourceName: y => `${y} 年普通考試一般行政`,
    targets: [
      { year: '111', code: '111090', c: '401', s: '0302' },
    ],
  },
  common_admin_law_junior: {
    subject: '行政法概要', sourceCode: 'civil-junior-general', idCode: 'civil-junior', tag: 'admin_law',
    sourceName: y => `${y} 年普通考試一般行政`,
    targets: [
      { year: '106', code: '106090', c: '401', s: '0705' },
    ],
  },
  common_law_knowledge: {
    subject: '法學知識與英文（包括中華民國憲法、法學緒論、英文）',
    sourceCode: 'civil-junior-general', tag: 'law_knowledge_combined',
    sourceName: y => `${y} 年普通考試一般行政`,
    targets: [
      { year: '103', code: '103080', c: '401', s: '0112' },
      { year: '104', code: '104080', c: '401', s: '0112' },
      { year: '105', code: '105080', c: '401', s: '0216' },
    ],
  },
}
const BANK_ID = process.argv.find((_, i) => process.argv[i - 1] === '--bank') || 'common_politics'
const CFG = CONFIGS[BANK_ID]
if (!CFG) { console.error('unknown --bank ' + BANK_ID); process.exit(1) }
const TARGETS = CFG.targets

function fetchPdf(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 20000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*' },
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(String(res.statusCode))) }
      const cs = []; res.on('data', c => cs.push(c)); res.on('end', () => resolve(Buffer.concat(cs)))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

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
  let curY = null, curRow = []
  for (const item of items) {
    if (curY === null || Math.abs(item.y - curY) > 3) {
      if (curRow.length) rows.push(curRow)
      curRow = [item]; curY = item.y
    } else curRow.push(item)
  }
  if (curRow.length) rows.push(curRow)
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
      curGroup = [item]; curY = item.y
    } else curGroup.push(item)
  }
  if (curGroup.length) yGroups.push(curGroup)
  const opts = []
  for (const group of yGroups) {
    group.sort((a, b) => a.x - b.x)
    const colTypes = new Set(group.map(it => it.col))
    if (colTypes.has('C0') || colTypes.has('C1') || colTypes.has('C2') || colTypes.has('C3')) {
      for (const item of group) opts.push(item.text)
    } else if (colTypes.has('L') && colTypes.has('R')) {
      opts.push(group.filter(it => it.col === 'L').map(it => it.text).join(''))
      opts.push(group.filter(it => it.col === 'R').map(it => it.text).join(''))
    } else {
      const fullText = group.map(it => it.text).join('')
      if (opts.length > 0 && group[0].x > 65 && group[0].col === 'F' && fullText.length < 6) {
        opts[opts.length - 1] += fullText
      } else opts.push(fullText)
    }
  }
  return opts
}

function parseQuestions(lines) {
  const filtered = lines.filter(l => {
    const t = l.text
    if (/^(代號|類\s*科|科\s*目|考試|頁次|等\s*別|本試題|座號|※|禁止|本科目|須用|共\d+題|甲、|乙、|申論題|測驗題)/.test(t)) return false
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
      if (/^年\s*(第|公務|專門|國家|特種)/.test(rest)) continue
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
          stemEndIdx = ri + 1; stemEnded = true; break
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

const stripPUA = s => typeof s === 'string' ? s.replace(/[-]/g, '').trim() : s

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const bankPath = path.join(__dirname, '..', 'shared-banks', `${BANK_ID}.json`)
  const bank = JSON.parse(fs.readFileSync(bankPath, 'utf-8'))
  const byId = new Map(bank.questions.map(q => [q.id, q]))
  let added = 0

  for (const t of TARGETS) {
    const qUrl = `${BASE}?t=Q&code=${t.code}&c=${t.c}&s=${t.s}&q=1`
    const aUrl = `${BASE}?t=S&code=${t.code}&c=${t.c}&s=${t.s}&q=1`
    const qBuf = await fetchPdf(qUrl)
    const aBuf = await fetchPdf(aUrl)

    let posItems = await extractPositionedText(qBuf)
    // skip to 測驗題 section
    const mcqIdx = posItems.findIndex(it => /測驗題|選擇題/.test(it.str))
    if (mcqIdx >= 0) posItems = posItems.slice(mcqIdx)
    const parsed = parseQuestions(buildLogicalLines(posItems))
    const answers = await parseAnswers(aBuf)
    console.log(`${t.year}: parsed ${parsed.length} Q / ${Object.keys(answers).length} A`)

    for (const q of parsed) {
      const id = `${BANK_ID}-${t.year}-${CFG.idCode || CFG.sourceCode}-${q.number}`
      if (byId.has(id)) continue
      const ans = answers[q.number]
      if (!ans) { console.log(`  ⚠ Q${q.number} no answer, skip`); continue }
      const cleanOpts = {}
      for (const k of ['A', 'B', 'C', 'D']) cleanOpts[k] = stripPUA(q.options[k] || '')
      if (Object.values(cleanOpts).filter(Boolean).length < 4) {
        console.log(`  ⚠ Q${q.number} incomplete options, skip`); continue
      }
      const row = {
        id, roc_year: t.year, session: '第一次',
        source_exam_code: CFG.sourceCode,
        source_exam_name: CFG.sourceName(t.year),
        subject: CFG.subject, subject_tags: [CFG.tag],
        number: q.number, question: stripPUA(q.question), options: cleanOpts,
        answer: ans, level: 'junior', shared_bank: BANK_ID,
        parent_id: null, case_context: null, is_deprecated: false, deprecated_reason: null,
      }
      byId.set(id, row)
      added++
      console.log(`  + Q${q.number} ${ans}  ${row.question.slice(0, 30)}`)
    }
  }

  if (added === 0) { console.log('\n(nothing to add)'); return }
  if (dryRun) { console.log(`\n[dry-run] would add ${added}`); return }
  bank.questions = Array.from(byId.values()).sort((a, b) =>
    a.roc_year.localeCompare(b.roc_year) || a.number - b.number)
  bank.bankVersion = (bank.bankVersion || 0) + 1
  bank.last_synced_at = new Date().toISOString()
  fs.writeFileSync(bankPath, JSON.stringify(bank, null, 2))
  console.log(`\n✅ +${added} → bank now ${bank.questions.length} total`)
}

main().catch(e => { console.error(e); process.exit(1) })
