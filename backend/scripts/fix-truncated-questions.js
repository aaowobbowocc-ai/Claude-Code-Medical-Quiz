#!/usr/bin/env node
/**
 * Fix questions and options that were truncated by the original scraper due to
 * 2-column PDF layout: the first half of each wrapped line is in column 1
 * (x≈52), and the continuation is in column 2 (x≈238) at the same y. The
 * original parser only read column 1 for some pages, dropping the tail of
 * each question/option.
 *
 * Also handles a rendering quirk where the first character of column 2
 * duplicates the last character of column 1 — we drop the duplicate.
 *
 * Strategy: re-download/read the PDF, rebuild the full text with bbox-aware
 * merging, parse it into question blocks, then update any JSON question whose
 * stored text is a prefix of the rebuilt text.
 */

const fs = require('fs')
const path = require('path')
const https = require('https')

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')
fs.mkdirSync(PDF_CACHE, { recursive: true })

function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 25000,
      headers: { 'User-Agent': UA, 'Accept': 'application/pdf,*/*', 'Referer': 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location
        if (!loc || !loc.startsWith('http')) { res.resume(); return reject(new Error('bad redirect')) }
        return fetchPdf(loc, retries).then(resolve, reject)
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', e => retries > 0 ? setTimeout(() => fetchPdf(url, retries - 1).then(resolve, reject), 1000) : reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function cachedPdf(tag, code, c, s) {
  const key = `${tag}_${code}_c${c}_s${s}.pdf`
  const p = path.join(PDF_CACHE, key)
  if (fs.existsSync(p) && fs.statSync(p).size > 1000) return fs.readFileSync(p)
  const url = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
  const buf = await fetchPdf(url)
  fs.writeFileSync(p, buf)
  return buf
}

// bbox-aware column merge with duplicate-char dedupe
function pageTextColumnAware(pg) {
  const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
  const lines = []
  for (const b of parsed.blocks) {
    if (b.type !== 'text') continue
    for (const ln of (b.lines || [])) {
      const t = ln.text || ''
      if (!t.trim()) continue
      lines.push({ y: Math.round(ln.bbox.y), x: Math.round(ln.bbox.x), text: t })
    }
  }
  lines.sort((a, b) => a.y - b.y || a.x - b.x)
  const groups = []
  for (const ln of lines) {
    const last = groups[groups.length - 1]
    if (last && Math.abs(last.y - ln.y) <= 3) last.parts.push(ln)
    else groups.push({ y: ln.y, parts: [ln] })
  }
  return groups.map(g => {
    g.parts.sort((a, b) => a.x - b.x)
    let merged = ''
    for (const p of g.parts) {
      const t = p.text
      if (merged && t) {
        // Strip trailing/leading space around the join point for comparison
        const mTrim = merged.replace(/\s+$/, '')
        const tTrim = t.replace(/^\s+/, '')
        const lastCh = mTrim[mTrim.length - 1]
        const firstCh = tTrim[0]
        if (lastCh && lastCh === firstCh && !/\s/.test(lastCh)) {
          merged = mTrim + tTrim.slice(1)
        } else {
          merged += t
        }
      } else merged += t
    }
    return merged.trim()
  }).join('\n')
}

// Parse cleaned page text into {num: {question, options}}
function parseQuestions(fullText) {
  const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean)
  const out = {}
  let cur = null, curOpt = null, qBuf = [], optBuf = ''
  let pendingNum = null
  function flushOpt() {
    if (cur && curOpt) cur.options[curOpt] = optBuf.trim()
    optBuf = ''; curOpt = null
  }
  function flushQ() {
    flushOpt()
    if (cur && Object.keys(cur.options).length >= 2) {
      cur.question = qBuf.join('').trim()
      if (cur.question) out[cur.num] = { question: cur.question, options: cur.options }
    }
    cur = null; qBuf = []
  }
  function tryStartQuestion(n, after) {
    const isSeq = !cur ? (n === 1) : n === cur.num + 1
    if (n >= 1 && n <= 120 && after && after.length >= 2 && isSeq) {
      flushQ()
      cur = { num: n, question: '', options: {} }
      qBuf = [after]
      return true
    }
    return false
  }
  for (const ln of lines) {
    // Orphan header "52." at page break: save and apply to next non-option line
    const mBare = ln.match(/^(\d{1,3})[.．、]\s*$/)
    if (mBare) {
      const n = +mBare[1]
      if (n >= 1 && n <= 120) { pendingNum = n; continue }
    }
    if (pendingNum != null) {
      const n = pendingNum
      pendingNum = null
      if (!/^[A-D][.．]/.test(ln)) {
        if (tryStartQuestion(n, ln)) continue
      }
    }
    const mQ = ln.match(/^(\d{1,3})[.．、]\s*(.*)/)
    if (mQ) {
      const n = +mQ[1]
      const after = mQ[2]
      if (tryStartQuestion(n, after)) continue
    }
    const mOpt = ln.match(/^([A-D])[.．]\s*(.*)/)
    if (mOpt && cur) {
      flushOpt()
      curOpt = mOpt[1]
      optBuf = mOpt[2]
      continue
    }
    if (curOpt) optBuf += ln
    else if (cur) qBuf.push(ln)
  }
  flushQ()
  return out
}

async function parsePdfQuestions(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n = doc.countPages()
  let full = ''
  for (let i = 0; i < n; i++) {
    const pg = doc.loadPage(i)
    full += pageTextColumnAware(pg) + '\n'
    try { pg.destroy?.() } catch {}
  }
  try { doc.destroy?.() } catch {}
  return parseQuestions(full)
}

// Exam → JSON file + class code. Subject codes are probed automatically
// because the scheme varies by year (e.g. legacy '33/44' vs newer '0103/0104'
// vs '0201/0202' etc.).
const EXAM_PAPERS = {
  doctor1: { file: 'questions.json', classCode: '301' },
  doctor2: { file: 'questions-doctor2.json', classCode: '302' },
  dental1: { file: 'questions-dental1.json', classCode: '303' },
  dental2: { file: 'questions-dental2.json', classCode: '304' },
  pharma1: { file: 'questions-pharma1.json', classCode: '305' },
  pharma2: { file: 'questions-pharma2.json', classCode: '306' },
}

const CANDIDATE_SUBJECT_CODES = [
  '11', '22', '33', '44', '55', '66', '77', '88',
  '0101', '0102', '0103', '0104', '0105', '0106',
  '0201', '0202', '0203', '0204', '0205', '0206',
  '0301', '0302', '0303', '0304', '0305', '0306',
  '0401', '0402', '0403', '0404', '0405', '0406',
  '0501', '0502', '0503', '0504', '0505', '0506',
  '0601', '0602', '0603', '0604', '0605', '0606',
]

const PROBE_CACHE = path.join(PDF_CACHE, '..', 'probe-results.json')
let probeCache = {}
try { probeCache = JSON.parse(fs.readFileSync(PROBE_CACHE, 'utf8')) } catch {}
function saveProbeCache() {
  try { fs.writeFileSync(PROBE_CACHE, JSON.stringify(probeCache, null, 2)) } catch {}
}

async function probeSubjectCodes(examTag, code, classCode) {
  const cacheKey = `${examTag}_${code}`
  if (probeCache[cacheKey]) return probeCache[cacheKey]
  const found = []
  for (const s of CANDIDATE_SUBJECT_CODES) {
    try {
      const buf = await cachedPdf(examTag, code, classCode, s)
      if (buf && buf.length > 100000) found.push(s)
    } catch {}
  }
  probeCache[cacheKey] = found
  saveProbeCache()
  return found
}

function isTruncated(text) {
  if (!text) return true
  const op = (text.match(/[（(]/g) || []).length
  const cl = (text.match(/[）)]/g) || []).length
  if (op > cl && /[a-zA-Z]$|[（(]$/.test(text.trim())) return true
  return false
}

// Normalize text for robust prefix matching: NFKC (halfwidth↔fullwidth),
// strip all whitespace + punctuation, lowercase.
function normText(t) {
  return (t || '').normalize('NFKC')
    .replace(/[\s,，、.。;；:：!！?？（）()\[\]【】{}「」『』"'"'“”‘’\-_—–~`]/g, '')
    .toLowerCase()
}

// Match a JSON question against a parsed PDF index by prefix.
// Also returns match if any option text strongly overlaps (for cases where
// question text is too short to be unique).
function findMatch(jsonQ, pdfIndex) {
  const qn = normText(jsonQ.question)
  const prefix = qn.slice(0, Math.min(15, qn.length))
  if (!prefix) return null
  for (const [num, pdfQ] of Object.entries(pdfIndex)) {
    const pn = normText(pdfQ.question)
    if (pn.startsWith(prefix) || pn.includes(prefix)) return { num: +num, pdfQ }
  }
  // Fallback: match by option text prefixes (useful when question is ~unique by A options)
  const optA = normText(jsonQ.options?.A || '').slice(0, 10)
  if (optA.length >= 6) {
    for (const [num, pdfQ] of Object.entries(pdfIndex)) {
      const pA = normText(pdfQ.options?.A || '')
      const pn = normText(pdfQ.question)
      if (pA.startsWith(optA) && pn.includes(qn.slice(0, 5))) return { num: +num, pdfQ }
    }
  }
  return null
}

async function fixExamCode(examTag, code, opts = {}) {
  const def = EXAM_PAPERS[examTag]
  if (!def) { console.log('no config for', examTag); return }
  const file = path.join(__dirname, '..', def.file)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const qs = Array.isArray(raw) ? raw : raw.questions
  const inScope = qs.filter(q => q.exam_code === code)
  if (!inScope.length) return
  const codes = await probeSubjectCodes(examTag, code, def.classCode)
  // Download/parse each valid PDF
  const pdfs = {}
  for (const s of codes) {
    try {
      const buf = await cachedPdf(examTag, code, def.classCode, s)
      if (buf.length < 2000) continue
      pdfs[s] = await parsePdfQuestions(buf)
    } catch {}
  }
  if (!Object.keys(pdfs).length) { console.log('  no PDFs for', examTag, code); return }

  // For each truncated question, find match and fix
  let fixedQ = 0, fixedO = 0, missing = 0
  for (const q of inScope) {
    const needQFix = isTruncated(q.question)
    const needOFix = q.options && Object.values(q.options).some(v => isTruncated(v))
    if (!needQFix && !needOFix) continue
    let match = null
    for (const pdfIdx of Object.values(pdfs)) {
      const m = findMatch(q, pdfIdx)
      if (m) { match = m; break }
    }
    if (!match) { missing++; continue }
    if (needQFix && match.pdfQ.question) {
      if (opts.dryRun) console.log('  [Q] Q' + q.number, q.question, '→', match.pdfQ.question)
      else q.question = match.pdfQ.question
      fixedQ++
    }
    if (needOFix && match.pdfQ.options) {
      for (const [k, v] of Object.entries(q.options)) {
        if (isTruncated(v) && match.pdfQ.options[k]) {
          if (opts.dryRun) console.log('  [O] Q' + q.number, k, v, '→', match.pdfQ.options[k])
          else q.options[k] = match.pdfQ.options[k]
          fixedO++
        }
      }
    }
  }
  if (!opts.dryRun && (fixedQ || fixedO)) {
    fs.writeFileSync(file, JSON.stringify(raw, null, 2))
  }
  console.log(`  ${examTag} ${code}: fixed ${fixedQ} questions + ${fixedO} options (${missing} unmatched)`)
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const filterExam = args.find(a => a.startsWith('--exam='))?.slice(7)
  const filterCode = args.find(a => a.startsWith('--code='))?.slice(7)

  // Scan every JSON for affected exam_codes
  const targets = []
  for (const [examTag, def] of Object.entries(EXAM_PAPERS)) {
    if (filterExam && filterExam !== examTag) continue
    const file = path.join(__dirname, '..', def.file)
    if (!fs.existsSync(file)) continue
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const qs = Array.isArray(raw) ? raw : raw.questions
    const codes = new Set()
    for (const q of qs) {
      if (filterCode && filterCode !== q.exam_code) continue
      if (isTruncated(q.question) || (q.options && Object.values(q.options).some(v => isTruncated(v)))) {
        codes.add(q.exam_code)
      }
    }
    for (const code of codes) targets.push({ examTag, code })
  }

  console.log(`Targets: ${targets.length}`)
  for (const t of targets) {
    console.log(`=== ${t.examTag} ${t.code} ===`)
    try { await fixExamCode(t.examTag, t.code, { dryRun }) }
    catch (e) { console.error('  error:', e.message) }
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1) })

module.exports = { fixExamCode, parsePdfQuestions, pageTextColumnAware }
