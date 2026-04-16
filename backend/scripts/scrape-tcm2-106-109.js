#!/usr/bin/env node
/**
 * One-shot scraper for 中醫師(二) 106-109 — first + second sessions.
 *
 * Sessions:
 *   106: 030(1st), 110(2nd)
 *   107: 030(1st), 110(2nd)
 *   108: 020(1st), 110(2nd)
 *   109: 030(1st), 110(2nd)
 *
 * All use c=102, s=0103..0106 (4 subjects matching tcm_clinical_1..4).
 * PDF format: no ABCD labels, column-positioned options (same as TCM1 106-109).
 *
 * Usage:
 *   node scripts/scrape-tcm2-106-109.js
 *   node scripts/scrape-tcm2-106-109.js --dry-run
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')
const TCM2_FILE = path.join(__dirname, '..', 'questions-tcm2.json')

const SESSIONS = [
  { year: '106', code: '106030', label: '第一次', classCode: '102' },
  { year: '106', code: '106110', label: '第二次', classCode: '102' },
  { year: '107', code: '107030', label: '第一次', classCode: '102' },
  { year: '107', code: '107110', label: '第二次', classCode: '102' },
  { year: '108', code: '108020', label: '第一次', classCode: '102' },
  { year: '108', code: '108110', label: '第二次', classCode: '102' },
  { year: '109', code: '109030', label: '第一次', classCode: '102' },
  { year: '109', code: '109110', label: '第二次', classCode: '102' },
]

const SUBJECTS = [
  { s: '0103', name: '中醫臨床醫學(一)', tag: 'tcm_clinical_1' },
  { s: '0104', name: '中醫臨床醫學(二)', tag: 'tcm_clinical_2' },
  { s: '0105', name: '中醫臨床醫學(三)', tag: 'tcm_clinical_3' },
  { s: '0106', name: '中醫臨床醫學(四)', tag: 'tcm_clinical_4' },
]

function fetchPdfRaw(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 20000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*',
                 Referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location
        if (!loc || !loc.startsWith('http')) { res.resume(); return reject(new Error('bad redirect')) }
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
  fs.mkdirSync(PDF_CACHE, { recursive: true })
  const fname = `tcm2_${kind}_${code}_c${c}_s${s}.pdf`
  const cur = path.join(PDF_CACHE, fname)
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
        lines.push({ y: Math.round(ln.bbox.y), x: Math.round(ln.bbox.x), w: Math.round(ln.bbox.w), text: t })
      }
    }
    lines.sort((a, b) => a.y - b.y || a.x - b.x)
    return lines
  }

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
    const seen = new Set()
    return anchors.filter(a => { if (seen.has(a.num)) return false; seen.add(a.num); return true })
  }

  function extractQuestion(lines, anchorY, nextAnchorY) {
    const between = lines.filter(ln =>
      ln.y >= anchorY - 2 && (nextAnchorY == null || ln.y < nextAnchorY - 2)
    )
    const content = between.filter(ln => ln.x > 60)
    if (!content.length) return null

    const rows = []
    for (const ln of content) {
      const last = rows[rows.length - 1]
      const clone = { y: ln.y, x: ln.x, w: ln.w, text: ln.text }
      if (last && Math.abs(last.y - ln.y) <= 3) last.parts.push(clone)
      else rows.push({ y: ln.y, parts: [clone] })
    }
    for (const r of rows) r.parts.sort((a, b) => a.x - b.x)

    for (let i = rows.length - 1; i > 0; i--) {
      const r = rows[i]
      if (r.parts.length === 1 && r.parts[0].x > 75) {
        rows[i - 1].parts[rows[i - 1].parts.length - 1].text += r.parts[0].text
        rows.splice(i, 1)
      }
    }

    const isMultiCol = r => {
      if (r.parts.length < 2) return false
      const xs = r.parts.map(p => p.x).sort((a, b) => a - b)
      for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > 50) return true
      return false
    }
    const mcIdxs = rows.map((r, i) => isMultiCol(r) ? i : -1).filter(i => i >= 0)

    let questionRows, optionParts
    if (mcIdxs.length > 0) {
      questionRows = rows.slice(0, mcIdxs[0])
      optionParts = []
      for (const r of rows.slice(mcIdxs[0])) for (const p of r.parts) optionParts.push(p)
    } else {
      if (rows.length < 4) return null
      questionRows = rows.slice(0, rows.length - 4)
      optionParts = rows.slice(rows.length - 4).map(r => r.parts[0])
    }

    if (optionParts.length < 4) return null
    const opts = optionParts.slice(0, 4).map(p => p.text.trim())
    const question = questionRows.map(r => r.parts.map(p => p.text).join('')).join('').trim()
    if (!question) return null
    return { question, options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] } }
  }

  const pageData = []
  for (let i = 0; i < n; i++) {
    const lines = parsePage(doc.loadPage(i))
    pageData.push({ lines, anchors: findAnchors(lines, i === 0) })
  }

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

// ─── Answer parsers ───

async function parseAnswersColumnAware(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n = doc.countPages()
  const orderedNums = [], orderedAns = []

  for (let pi = 0; pi < n; pi++) {
    const pg = doc.loadPage(pi)
    const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
    const lines = []
    for (const b of parsed.blocks) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const t = (ln.text || '').trim()
        if (!t) continue
        lines.push({ y: Math.round(ln.bbox.y), x: Math.round(ln.bbox.x), text: t })
      }
    }
    lines.sort((a, b) => a.y - b.y || a.x - b.x)

    const rows = []
    for (const ln of lines) {
      const last = rows[rows.length - 1]
      if (last && Math.abs(last.y - ln.y) <= 3) last.parts.push(ln)
      else rows.push({ y: ln.y, parts: [ln] })
    }

    for (const r of rows) {
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
      const hasLabel = r.parts.some(p => p.text === '答案')
      if (!hasLabel) continue
      const letters = []
      for (const p of r.parts) {
        if (p.text === '答案') continue
        if (/^[A-D]$/.test(p.text)) letters.push({ x: p.x, ch: p.text })
        else if (/^[ＡＢＣＤ]$/.test(p.text)) {
          const ch = p.text === 'Ａ' ? 'A' : p.text === 'Ｂ' ? 'B' : p.text === 'Ｃ' ? 'C' : 'D'
          letters.push({ x: p.x, ch })
        }
      }
      if (letters.length >= 2) {
        letters.sort((a, b) => a.x - b.x)
        for (const l of letters) orderedAns.push(l.ch)
      }
    }
  }

  const ans = {}
  const len = Math.min(orderedNums.length, orderedAns.length)
  for (let i = 0; i < len; i++) ans[orderedNums[i]] = orderedAns[i]
  return ans
}

async function parseAnswersPdfParse(buf) {
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

function parseCorrections(text) {
  const corrections = {}
  for (const line of text.split(/\n/)) {
    const give = line.match(/第?\s*(\d{1,3})\s*題.*(?:一律給分|送分)/i)
    if (give) { corrections[parseInt(give[1])] = '*'; continue }
    const change = line.match(/第?\s*(\d{1,3})\s*題.*更正.*([ＡＢＣＤA-D])/i)
    if (change) {
      let ch = change[2]
      if (ch === 'Ａ') ch = 'A'; else if (ch === 'Ｂ') ch = 'B'
      else if (ch === 'Ｃ') ch = 'C'; else if (ch === 'Ｄ') ch = 'D'
      corrections[parseInt(change[1])] = ch
    }
  }
  return corrections
}

const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const existing = JSON.parse(fs.readFileSync(TCM2_FILE, 'utf8'))
  const existingQs = existing.questions || []
  let nextId = (existingQs.reduce((m, q) => Math.max(m, +q.id || 0), 0)) + 1

  const existingKeys = new Set(existingQs.map(q =>
    `${q.roc_year}|${q.session}|${q.exam_code}|${q.subject_tag}|${q.number}`
  ))

  const newQs = []
  let totalParsed = 0, totalKept = 0

  for (const sess of SESSIONS) {
    console.log(`\n=== ${sess.year}年${sess.label} (${sess.code}, c=${sess.classCode}) ===`)
    for (const sub of SUBJECTS) {
      try {
        const qBuf = await cachedPdf('Q', sess.code, sess.classCode, sub.s)
        const sBuf = await cachedPdf('S', sess.code, sess.classCode, sub.s).catch(() => null)
        let mBuf = null
        try { mBuf = await cachedPdf('M', sess.code, sess.classCode, sub.s) } catch {}

        const parsed = await parseQuestionsColumnAware(qBuf)
        let answers = {}
        if (sBuf) {
          answers = await parseAnswersColumnAware(sBuf)
          if (Object.keys(answers).length < 5) answers = await parseAnswersPdfParse(sBuf)
        }
        const corrections = mBuf ? parseCorrections((await pdfParse(mBuf)).text) : {}
        for (const [num, ch] of Object.entries(corrections)) {
          if (ch !== '*') answers[num] = ch
        }

        const numKeys = Object.keys(parsed).map(n => +n).sort((a, b) => a - b)
        console.log(`  ${sub.tag}: ${numKeys.length}Q / ${Object.keys(answers).length}A / ${Object.keys(corrections).length} corr`)
        totalParsed += numKeys.length

        for (const num of numKeys) {
          const q = parsed[num]
          const a = answers[num]
          if (!a) continue
          if (!q.question || !q.options.A || !q.options.B || !q.options.C || !q.options.D) continue
          const dupKey = `${sess.year}|${sess.label}|${sess.code}|${sub.tag}|${num}`
          if (existingKeys.has(dupKey)) continue
          newQs.push({
            id: nextId++, roc_year: sess.year, session: sess.label, exam_code: sess.code,
            subject: sub.name, subject_tag: sub.tag, subject_name: sub.name,
            stage_id: 0, number: num,
            question: stripPUA(q.question),
            options: { A: stripPUA(q.options.A), B: stripPUA(q.options.B),
                       C: stripPUA(q.options.C), D: stripPUA(q.options.D) },
            answer: a, explanation: '',
            ...(corrections[num] === '*' ? { disputed: true } : {}),
          })
          totalKept++
        }
        await sleep(300)
      } catch (e) {
        console.log(`  ✗ ${sub.tag}: ${e.message}`)
      }
    }
  }

  console.log(`\nTotal parsed: ${totalParsed}, kept: ${totalKept}`)
  if (dryRun) { console.log('--dry-run'); return }
  if (!newQs.length) { console.log('No new questions'); return }

  existing.questions = existingQs.concat(newQs)
  existing.total = existing.questions.length
  if (existing.metadata) existing.metadata.last_updated = new Date().toISOString()
  const tmp = TCM2_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2), 'utf-8')
  fs.renameSync(tmp, TCM2_FILE)
  console.log(`✅ ${existingQs.length} → ${existing.questions.length} questions`)
}

main().catch(e => { console.error(e); process.exit(1) })
