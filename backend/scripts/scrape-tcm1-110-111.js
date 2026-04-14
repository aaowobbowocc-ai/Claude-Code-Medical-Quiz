#!/usr/bin/env node
/**
 * One-shot recovery script for 中醫師(一) 110-111 全部 4 場次（共 8 PDF, 640 題）。
 *
 * Why a separate script: 110-111 的試題 PDF 完全沒有 A/B/C/D 字母標籤（題號、
 * 題幹、4 個選項都用 x 座標排版，沒有任何前綴），現有的 scrape-moex.js /
 * scrape-tcm-vet.js 用 pdf-parse 拿不到 x 座標就無法切欄。這個腳本改用 mupdf
 * 的 structured text、靠 column position 還原 A/B/C/D。
 *
 * Layout 觀察：
 *   題號：x ≤ 60、單字寬度 ≤ 18，孤立的 1-2 位數
 *   題幹：x ≈ 69，題號右邊
 *   選項：3 種排版
 *     1) 1 欄  - 4 行各自 x=69（單欄連續 4 行）
 *     2) 2 欄  - 2 行 × 2 欄，pairs 在 x=69 與 x=307
 *     3) 4 欄  - 1 行 4 欄，x=69, 187, 307, 427
 *   讀法皆為 row-major（左到右、上到下）→ A, B, C, D
 *
 * 答案 PDF 用既有的全形答案 regex（與 scrape-tcm-vet.js 相同邏輯）。
 *
 * 此腳本只 *附加* 110-111 題目到 questions-tcm1.json，不動現有 800 題（112-114
 * 都正常運作中、不需重爬）。新題 id 從 max(existing)+1 開始。
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')
const TCM1_FILE = path.join(__dirname, '..', 'questions-tcm1.json')

// 中醫師(一) 在 110-111 用 c=101，s=0101/0102
const SESSIONS = [
  { year: '110', code: '110030', label: '第一次', classCode: '101' },
  { year: '110', code: '110111', label: '第二次', classCode: '101' },
  { year: '111', code: '111030', label: '第一次', classCode: '101' },
  { year: '111', code: '111110', label: '第二次', classCode: '101' },
]

const SUBJECTS = [
  { s: '0101', name: '中醫基礎醫學(一)', tag: 'tcm_basic_1' },
  { s: '0102', name: '中醫基礎醫學(二)', tag: 'tcm_basic_2' },
]

// ─── HTTP with cache ───
function fetchPdfRaw(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 20000,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/pdf,*/*',
        'Referer': 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx',
      },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location
        if (!loc || !loc.startsWith('http')) { res.resume(); return reject(new Error(`bad redirect`)) }
        return fetchPdfRaw(loc, retries).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        if (retries > 0) return setTimeout(() => fetchPdfRaw(url, retries - 1).then(resolve, reject), 1000)
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      const cs = []
      res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    })
    req.on('error', e => retries > 0
      ? setTimeout(() => fetchPdfRaw(url, retries - 1).then(resolve, reject), 1000)
      : reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function cachedPdf(kind, code, c, s) {
  // kind: 'Q' | 'S' | 'M'
  fs.mkdirSync(PDF_CACHE, { recursive: true })
  const fname = `tcm1_${kind}_${code}_c${c}_s${s}.pdf`
  // also accept the legacy `tcm1_{code}_c{c}_s{s}.pdf` for Q (no kind prefix)
  const legacy = path.join(PDF_CACHE, `tcm1_${code}_c${c}_s${s}.pdf`)
  const cur = path.join(PDF_CACHE, fname)
  if (kind === 'Q' && fs.existsSync(legacy) && fs.statSync(legacy).size > 100000) return fs.readFileSync(legacy)
  if (fs.existsSync(cur) && fs.statSync(cur).size > 1000) return fs.readFileSync(cur)
  const url = `${BASE}?t=${kind}&code=${code}&c=${c}&s=${s}&q=1`
  const buf = await fetchPdfRaw(url)
  fs.writeFileSync(cur, buf)
  return buf
}

// ─── Column-aware question parser using mupdf ───

async function parseQuestionsColumnAware(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n = doc.countPages()

  function parsePage(pg) {
    const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
    const lines = []
    for (const b of parsed.blocks) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const t = (ln.text || '').trim()
        if (!t) continue
        lines.push({
          y: Math.round(ln.bbox.y),
          x: Math.round(ln.bbox.x),
          w: Math.round(ln.bbox.w),
          text: t,
        })
      }
    }
    lines.sort((a, b) => a.y - b.y || a.x - b.x)
    return lines
  }

  // Strip header garbage: lines with y < 220 on page 1 only (header/instructions
  // sit above the first question's y ≈ 234). On subsequent pages we keep
  // everything because pages start with content immediately under the page
  // number footer.
  function findAnchors(lines, isFirstPage) {
    const anchors = []
    for (const ln of lines) {
      if (ln.x > 60) continue
      if (ln.w > 22) continue
      const m = ln.text.match(/^(\d{1,3})$/)
      if (!m) continue
      const num = +m[1]
      if (num < 1 || num > 120) continue
      if (isFirstPage && ln.y < 220) continue
      anchors.push({ num, y: ln.y, x: ln.x })
    }
    // Dedupe (keep first occurrence)
    const seen = new Set()
    return anchors.filter(a => {
      if (seen.has(a.num)) return false
      seen.add(a.num)
      return true
    })
  }

  // Group lines between anchorY and nextAnchorY into question + options.
  // Returns { question, options: {A,B,C,D} } or null.
  function extractQuestion(lines, anchorY, nextAnchorY) {
    const between = lines.filter(ln =>
      ln.y >= anchorY - 2 && (nextAnchorY == null || ln.y < nextAnchorY - 2)
    )
    // Drop the anchor line itself (the bare number at x ≤ 60)
    const content = between.filter(ln => ln.x > 60)
    if (!content.length) return null

    // Group by y (rows) — clone parts so later mutation doesn't leak back to
    // the shared pageData.lines.
    const rows = []
    for (const ln of content) {
      const last = rows[rows.length - 1]
      const clone = { y: ln.y, x: ln.x, w: ln.w, text: ln.text }
      if (last && Math.abs(last.y - ln.y) <= 3) last.parts.push(clone)
      else rows.push({ y: ln.y, parts: [clone] })
    }
    for (const r of rows) r.parts.sort((a, b) => a.x - b.x)

    // Merge wrap continuations: a row whose sole part starts at x > 75 (i.e.,
    // not at the canonical x≈69-72 start-of-line column) is a wrap from the
    // previous row. Concatenate its text into the previous row and drop it.
    // Question lines wrap to x=69 too (same as fresh lines), but option text
    // sometimes wraps with a small indent (x=83). Use x>75 as the cutoff.
    for (let i = rows.length - 1; i > 0; i--) {
      const r = rows[i]
      if (r.parts.length === 1 && r.parts[0].x > 75) {
        const prev = rows[i - 1]
        // Append the wrapped text to the last part of the previous row.
        const lastPart = prev.parts[prev.parts.length - 1]
        lastPart.text += r.parts[0].text
        rows.splice(i, 1)
      }
    }

    // Multi-column option row = a row whose parts span > 50px gap somewhere
    const isMultiCol = r => {
      if (r.parts.length < 2) return false
      const xs = r.parts.map(p => p.x).sort((a, b) => a - b)
      for (let i = 1; i < xs.length; i++) {
        if (xs[i] - xs[i - 1] > 50) return true
      }
      return false
    }
    const mcIdxs = rows.map((r, i) => isMultiCol(r) ? i : -1).filter(i => i >= 0)

    let questionRows, optionParts
    if (mcIdxs.length > 0) {
      const firstMC = mcIdxs[0]
      questionRows = rows.slice(0, firstMC)
      const optRows = rows.slice(firstMC)
      optionParts = []
      for (const r of optRows) for (const p of r.parts) optionParts.push(p)
    } else {
      // No multi-col → all single-column. Last 4 single-col rows = options.
      if (rows.length < 4) return null
      questionRows = rows.slice(0, rows.length - 4)
      optionParts = rows.slice(rows.length - 4).map(r => r.parts[0])
    }

    if (optionParts.length < 4) return null
    const opts = optionParts.slice(0, 4).map(p => p.text.trim())

    // Question text: concatenate all parts of all question rows, but keep
    // multi-row spacing minimal (no newlines — paste together).
    const question = questionRows
      .map(r => r.parts.map(p => p.text).join(''))
      .join('')
      .trim()
    if (!question) return null

    return { question, options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] } }
  }

  // Build pageData
  const pageData = []
  for (let i = 0; i < n; i++) {
    const lines = parsePage(doc.loadPage(i))
    pageData.push({ lines, anchors: findAnchors(lines, i === 0) })
  }

  // For each anchor, extract its question. If the anchor is the last on its
  // page, append the next page's leading lines (until next page's first
  // anchor) to handle questions that wrap across page boundaries.
  const out = {}
  for (let pi = 0; pi < pageData.length; pi++) {
    const { lines, anchors } = pageData[pi]
    for (let ai = 0; ai < anchors.length; ai++) {
      const a = anchors[ai]
      const nextY = ai + 1 < anchors.length ? anchors[ai + 1].y : null
      let q
      if (nextY == null && pi + 1 < pageData.length) {
        const np = pageData[pi + 1]
        const nextAnchorY = np.anchors.length ? np.anchors[0].y : null
        const tail = np.lines.filter(ln => nextAnchorY == null || ln.y < nextAnchorY - 2)
        q = extractQuestion(lines.concat(tail), a.y, null)
      } else {
        q = extractQuestion(lines, a.y, nextY)
      }
      if (q && !out[a.num]) out[a.num] = q
    }
  }

  return out
}

// ─── Column-aware answer parser (mupdf) ───
// 110-111 answer PDFs are rendered as a table — 10 questions per row, with a
// 題號 row (第1題..第10題) immediately followed by a 答案 row (A..D × 10), all
// at specific x columns. pdf-parse's linearized output scrambles this order,
// so we read each row with mupdf and zip the two sequences.

async function parseAnswersColumnAware(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n = doc.countPages()
  const ans = {}
  const orderedNums = []
  const orderedAns = []

  for (let pi = 0; pi < n; pi++) {
    const pg = doc.loadPage(pi)
    const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
    const lines = []
    for (const b of parsed.blocks) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const t = (ln.text || '').trim()
        if (!t) continue
        lines.push({
          y: Math.round(ln.bbox.y),
          x: Math.round(ln.bbox.x),
          text: t,
        })
      }
    }
    lines.sort((a, b) => a.y - b.y || a.x - b.x)

    // Group by y (±3) into rows
    const rows = []
    for (const ln of lines) {
      const last = rows[rows.length - 1]
      if (last && Math.abs(last.y - ln.y) <= 3) last.parts.push(ln)
      else rows.push({ y: ln.y, parts: [ln] })
    }

    for (const r of rows) {
      // 題號 row: any part matches 第N題
      const nums = []
      for (const p of r.parts) {
        const m = p.text.match(/^第(\d{1,3})題$/)
        if (m) nums.push({ x: p.x, num: +m[1] })
      }
      if (nums.length >= 2) {
        nums.sort((a, b) => a.x - b.x)
        for (const nn of nums) orderedNums.push(nn.num)
        continue
      }
      // 答案 row: one part is "答案", rest are A/B/C/D single chars
      const hasLabel = r.parts.some(p => p.text === '答案')
      if (!hasLabel) continue
      const letters = []
      for (const p of r.parts) {
        if (p.text === '答案') continue
        // Accept half-width A-D, full-width ＡＢＣＤ, or #/＃ (disputed)
        const t = p.text
        if (/^[A-D]$/.test(t)) letters.push({ x: p.x, ch: t })
        else if (/^[ＡＢＣＤ]$/.test(t)) {
          const ch = t === 'Ａ' ? 'A' : t === 'Ｂ' ? 'B' : t === 'Ｃ' ? 'C' : 'D'
          letters.push({ x: p.x, ch })
        }
      }
      if (letters.length >= 2) {
        letters.sort((a, b) => a.x - b.x)
        for (const l of letters) orderedAns.push(l.ch)
      }
    }
  }

  // Zip — both sequences should be same length and in reading order
  const len = Math.min(orderedNums.length, orderedAns.length)
  for (let i = 0; i < len; i++) ans[orderedNums[i]] = orderedAns[i]
  return ans
}

function parseCorrections(text) {
  const corrections = {}
  for (const line of text.split(/\n/)) {
    const give = line.match(/第?\s*(\d{1,3})\s*題.*(?:一律給分|送分)/i)
    if (give) { corrections[parseInt(give[1])] = '*'; continue }
    const change = line.match(/第?\s*(\d{1,3})\s*題.*更正.*([ＡＢＣＤA-D])/i)
    if (change) {
      let ch = change[2]
      if (ch === 'Ａ') ch = 'A'
      else if (ch === 'Ｂ') ch = 'B'
      else if (ch === 'Ｃ') ch = 'C'
      else if (ch === 'Ｄ') ch = 'D'
      corrections[parseInt(change[1])] = ch
    }
  }
  return corrections
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── Main ───

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')

  // Load existing tcm1
  const existing = JSON.parse(fs.readFileSync(TCM1_FILE, 'utf8'))
  const existingQs = existing.questions || []
  let nextId = (existingQs.reduce((m, q) => Math.max(m, +q.id || 0), 0)) + 1

  // Track existing (year, session, exam_code, subject_tag, number) so we can
  // skip if 110/111 was somehow already partially imported.
  const existingKeys = new Set(existingQs.map(q =>
    `${q.roc_year}|${q.session}|${q.exam_code}|${q.subject_tag}|${q.number}`
  ))

  const newQs = []
  let totalParsed = 0, totalKept = 0

  for (const sess of SESSIONS) {
    console.log(`\n=== ${sess.year}年${sess.label} (${sess.code}, c=${sess.classCode}) ===`)
    for (const sub of SUBJECTS) {
      const key = `${sub.s} ${sub.name}`
      try {
        const qBuf = await cachedPdf('Q', sess.code, sess.classCode, sub.s)
        const sBuf = await cachedPdf('S', sess.code, sess.classCode, sub.s).catch(() => null)
        let mBuf = null
        try { mBuf = await cachedPdf('M', sess.code, sess.classCode, sub.s) } catch {}

        const parsed = await parseQuestionsColumnAware(qBuf)
        const answers = sBuf ? await parseAnswersColumnAware(sBuf) : {}
        const corrections = mBuf ? parseCorrections((await pdfParse(mBuf)).text) : {}
        for (const [num, ch] of Object.entries(corrections)) {
          if (ch !== '*') answers[num] = ch
        }

        const numKeys = Object.keys(parsed).map(n => +n).sort((a, b) => a - b)
        console.log(`  ${key}: parsed ${numKeys.length}Q, ${Object.keys(answers).length}A, ${Object.keys(corrections).length} corrections`)
        totalParsed += numKeys.length

        for (const num of numKeys) {
          const q = parsed[num]
          const a = answers[num]
          if (!a) continue
          if (!q.question || !q.options.A || !q.options.B || !q.options.C || !q.options.D) continue
          const dupKey = `${sess.year}|${sess.label}|${sess.code}|${sub.tag}|${num}`
          if (existingKeys.has(dupKey)) continue
          newQs.push({
            id: nextId++,
            roc_year: sess.year,
            session: sess.label,
            exam_code: sess.code,
            subject: sub.name,
            subject_tag: sub.tag,
            subject_name: sub.name,
            stage_id: 0,
            number: num,
            question: q.question,
            options: q.options,
            answer: a,
            explanation: '',
            ...(corrections[num] === '*' ? { disputed: true } : {}),
          })
          totalKept++
        }
        await sleep(200)
      } catch (e) {
        console.log(`  ✗ ${key}: ${e.message}`)
      }
    }
  }

  console.log(`\nTotal parsed: ${totalParsed}, kept (with answer + 4 options): ${totalKept}`)

  if (dryRun) {
    console.log('--dry-run, not writing')
    return
  }
  if (!newQs.length) {
    console.log('No new questions, file unchanged')
    return
  }

  existing.questions = existingQs.concat(newQs)
  existing.total = existing.questions.length
  if (existing.metadata) existing.metadata.last_updated = new Date().toISOString()
  fs.writeFileSync(TCM1_FILE, JSON.stringify(existing, null, 2), 'utf-8')
  console.log(`✅ Wrote ${TCM1_FILE} (${existingQs.length} → ${existing.questions.length} questions)`)
}

main().catch(e => { console.error(e); process.exit(1) })
