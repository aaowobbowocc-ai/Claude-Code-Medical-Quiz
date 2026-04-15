#!/usr/bin/env node
/**
 * Verify `incomplete: "missing_image"` flags against source PDFs.
 *
 * Users reported that medlab has many questions marked "本題含有圖片但無法顯示"
 * that don't actually have images in the source PDF. The flag was set by an
 * earlier heuristic (likely keyword-based: 心電圖/圖示/如圖...) without actually
 * checking whether the PDF contains an image block near that question's anchor.
 *
 * This script:
 *   1. For each exam, finds all questions with `incomplete === 'missing_image'`.
 *   2. Downloads the relevant PDFs (uses same _tmp/pdf-cache as fix-images.js).
 *   3. For each flagged question, matches it to the PDF by text prefix, then
 *      checks if there's an image block on the same page + roughly near the
 *      question anchor.
 *   4. If no matching image → the flag is bogus. Clear it (delete the
 *      `incomplete` field and leave `images` untouched).
 *
 * Runs in dry-run by default. Pass `--write` to persist changes.
 *
 * Usage:
 *   node scripts/verify-missing-image-flags.js --exam=medlab
 *   node scripts/verify-missing-image-flags.js --exam=medlab --write
 *   node scripts/verify-missing-image-flags.js --all --write
 */

const fs = require('fs')
const path = require('path')
const https = require('https')

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')
const MIN_IMG_DIM = 30

fs.mkdirSync(PDF_CACHE, { recursive: true })

// ─── Exam registry ─────────────────────────────────────────────────────
// Each exam: { file, classCode, subjectCodes: [s...] } for PDF lookups.
// subjectCodes is a UNION across sessions — the PDF cache key encodes
// (exam, code, c, s) so we just try all known s values per exam_code.
const EXAMS = {
  doctor1:   { file: 'questions.json',           classCode: '301', subjectCodes: ['11','22','33','44','55'] },
  doctor2:   { file: 'questions-doctor2.json',   classCode: '302', subjectCodes: ['11','22','33','44','55','66','77','88'] },
  dental1:   { file: 'questions-dental1.json',   classCode: '303', subjectCodes: ['11','22','33','44'] },
  dental2:   { file: 'questions-dental2.json',   classCode: '304', subjectCodes: ['11','22','33','44','55','66','77','88'] },
  pharma1:   { file: 'questions-pharma1.json',   classCode: '305', subjectCodes: ['11','22','33','44','55','66'] },
  pharma2:   { file: 'questions-pharma2.json',   classCode: '306', subjectCodes: ['11','22','33','44','55'] },
  nursing:   { file: 'questions-nursing.json',   classCode: '101', subjectCodes: ['0101','0102','0103','0104','0105'] },
  nutrition: { file: 'questions-nutrition.json', classCode: '102', subjectCodes: ['0201','0202','0203','0204','0205','0206','11','22','33','44','55','66'] },
  medlab:    { file: 'questions-medlab.json',    classCode: '308', subjectCodes: ['0103','0107','0501','0502','0503','0504','0505'] },
  pt:        { file: 'questions-pt.json',        classCode: '311', subjectCodes: ['0701','0702','0703','0704','0705','0706'] },
  ot:        { file: 'questions-ot.json',        classCode: '312', subjectCodes: ['0105','0801','0802','0803','0804','0805'] },
  radiology: { file: 'questions-radiology.json', classCode: '309', subjectCodes: ['0108','0601','0602','0603','0604','0605'] },
}

// ─── PDF download (cached) ─────────────────────────────────────────────
function fetchPdf(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 25000,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/pdf,*/*',
        'Referer': 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx',
      },
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
async function cachedPdf(exam, code, c, s) {
  const key = `${exam}_${code}_c${c}_s${s}.pdf`
  const p = path.join(PDF_CACHE, key)
  if (fs.existsSync(p) && fs.statSync(p).size > 1000) return fs.readFileSync(p)
  const url = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
  try {
    const buf = await fetchPdf(url)
    fs.writeFileSync(p, buf)
    return buf
  } catch {
    return null
  }
}

// ─── Text normalization + matching ─────────────────────────────────────
function normText(t) {
  return (t || '').normalize('NFKC')
    .replace(/[\s,，、.。;；:：!！?？（）()\[\]【】{}「」『』"'"'“”‘’\-_—–~`]/g, '')
    .toLowerCase()
}

// ─── mupdf: full PDF parse (text + anchors + images) ──────────────────
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
    return g.parts.map(p => p.text).join('').trim()
  }).join('\n')
}

function parseQuestionsFromText(fullText) {
  const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean)
  const out = {}
  let cur = null, curOpt = null, qBuf = [], optBuf = ''
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
  for (const ln of lines) {
    const mQ = ln.match(/^(\d{1,3})[.．、]\s*(.*)/)
    if (mQ) {
      const n = +mQ[1]
      const after = mQ[2]
      const isSeq = !cur ? (n === 1) : n === cur.num + 1
      if (n >= 1 && n <= 120 && after && after.length >= 2 && isSeq) {
        flushQ()
        cur = { num: n, question: '', options: {} }
        qBuf = [after]
        continue
      }
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

async function parsePdfFull(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n = doc.countPages()
  let fullText = ''
  const pages = []
  for (let i = 0; i < n; i++) {
    const pg = doc.loadPage(i)
    fullText += pageTextColumnAware(pg) + '\n'
    const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
    const anchors = []
    for (const b of parsed.blocks) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const txt = (ln.text || '').trim()
        const m = txt.match(/^(\d{1,3})[.．、]\s*(.*)/)
        if (!m) continue
        const num = parseInt(m[1], 10)
        if (num < 1 || num > 120) continue
        const after = m[2]
        if (!after || after.length < 2) continue
        anchors.push({ num, y: ln.bbox.y, x: ln.bbox.x })
      }
    }
    const dedup = new Map()
    for (const a of anchors.sort((a, b) => a.y - b.y || a.x - b.x)) {
      if (!dedup.has(a.num)) dedup.set(a.num, a)
    }
    const uniqAnchors = [...dedup.values()].sort((a, b) => a.y - b.y)
    const images = []
    for (const b of parsed.blocks) {
      if (b.type !== 'image') continue
      const bb = b.bbox
      if (bb.w < MIN_IMG_DIM || bb.h < MIN_IMG_DIM) continue
      images.push({ bbox: bb, pageIdx: i })
    }
    pages.push({ pageNum: i + 1, pageIdx: i, anchors: uniqAnchors, images })
    try { pg.destroy?.() } catch {}
  }
  try { doc.destroy?.() } catch {}
  const textIndex = parseQuestionsFromText(fullText)
  return { textIndex, pages }
}

// Match image block to its owning question number (nearest anchor above on
// same page, or last anchor on previous page if no anchor precedes).
function matchImageToPdfNum(img, page, prevPages) {
  const imgTop = img.bbox.y
  const above = page.anchors.filter(a => a.y <= imgTop + 5).sort((a, b) => b.y - a.y)
  if (above.length) return above[0].num
  for (let i = prevPages.length - 1; i >= 0; i--) {
    const p = prevPages[i]
    if (p.anchors.length) return Math.max(...p.anchors.map(a => a.num))
  }
  return null
}

// Find JSON question in PDF by text prefix match
function findMatch(jsonQ, pdfIndex) {
  const qn = normText(jsonQ.question)
  const prefix = qn.slice(0, Math.min(15, qn.length))
  if (!prefix) return null
  for (const [num, pdfQ] of Object.entries(pdfIndex)) {
    const pn = normText(pdfQ.question)
    if (pn.startsWith(prefix) || pn.includes(prefix)) return +num
  }
  return null
}

// Build a map of pdfNum → true iff an image block exists on that question
async function buildImageOwnershipMap(pdfs) {
  const hasImage = {} // { [pdfIdx]: Set<pdfNum> }
  for (let pi = 0; pi < pdfs.length; pi++) {
    const pdf = pdfs[pi]
    const set = new Set()
    for (let i = 0; i < pdf.pages.length; i++) {
      const page = pdf.pages[i]
      const prev = pdf.pages.slice(0, i)
      for (const img of page.images) {
        const num = matchImageToPdfNum(img, page, prev)
        if (num != null) set.add(num)
      }
    }
    hasImage[pi] = set
  }
  return hasImage
}

// ─── Main: process one exam ────────────────────────────────────────────
async function verifyExam(examTag, { write }) {
  const def = EXAMS[examTag]
  if (!def) throw new Error(`unknown exam ${examTag}`)
  const file = path.join(__dirname, '..', def.file)
  if (!fs.existsSync(file)) { console.log(`  skip: no ${def.file}`); return { exam: examTag, flagged: 0, cleared: 0 } }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const qs = Array.isArray(raw) ? raw : raw.questions

  const flagged = qs.filter(q => q.incomplete === 'missing_image' && !(q.images?.length))
  if (!flagged.length) { console.log(`  ${examTag}: no empty missing_image flags`); return { exam: examTag, flagged: 0, cleared: 0 } }

  console.log(`  ${examTag}: ${flagged.length} questions to verify`)

  // Group by exam_code
  const byCode = {}
  for (const q of flagged) {
    if (!byCode[q.exam_code]) byCode[q.exam_code] = []
    byCode[q.exam_code].push(q)
  }

  let totalCleared = 0
  let totalConfirmed = 0
  let totalUnmatched = 0

  for (const code of Object.keys(byCode).sort()) {
    const group = byCode[code]
    console.log(`    ${code}: ${group.length} questions`)
    // Try all known subject codes for this exam_code
    const pdfs = []
    for (const s of def.subjectCodes) {
      const buf = await cachedPdf(examTag, code, def.classCode, s)
      if (!buf || buf.length < 2000) continue
      try {
        const parsed = await parsePdfFull(buf)
        pdfs.push({ s, ...parsed })
      } catch (e) { console.error(`      parse ${s} failed: ${e.message}`) }
    }
    if (!pdfs.length) { console.log(`      no PDFs loaded`); continue }

    const imageMaps = await buildImageOwnershipMap(pdfs)

    for (const q of group) {
      // Find which PDF this question belongs to
      let hit = null
      for (let pi = 0; pi < pdfs.length; pi++) {
        const num = findMatch(q, pdfs[pi].textIndex)
        if (num != null) { hit = { pi, num }; break }
      }
      if (!hit) {
        totalUnmatched++
        continue
      }
      const hasImg = imageMaps[hit.pi].has(hit.num)
      if (hasImg) {
        totalConfirmed++
        // Flag stands — PDF really has an image near this question
        // but extraction failed. Leave alone.
      } else {
        totalCleared++
        if (write) delete q.incomplete
      }
    }
  }

  console.log(`  ${examTag}: flagged=${flagged.length} confirmed=${totalConfirmed} cleared=${totalCleared} unmatched=${totalUnmatched}`)

  if (write && totalCleared > 0) {
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n')
    console.log(`    ✓ wrote ${def.file}`)
  }

  return { exam: examTag, flagged: flagged.length, confirmed: totalConfirmed, cleared: totalCleared, unmatched: totalUnmatched }
}

async function main() {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const all = args.includes('--all')
  const examArg = args.find(a => a.startsWith('--exam='))?.slice(7)

  let exams
  if (all) exams = Object.keys(EXAMS)
  else if (examArg) exams = examArg.split(',')
  else {
    console.log('Usage: node verify-missing-image-flags.js --exam=medlab [--write]')
    console.log('       node verify-missing-image-flags.js --all [--write]')
    process.exit(1)
  }

  console.log(`Mode: ${write ? 'WRITE' : 'dry-run'}`)
  console.log(`Exams: ${exams.join(', ')}\n`)

  const results = []
  for (const ex of exams) {
    console.log(`=== ${ex} ===`)
    try {
      results.push(await verifyExam(ex, { write }))
    } catch (e) {
      console.error(`  error: ${e.message}`)
    }
  }

  console.log('\n=== Summary ===')
  const total = results.reduce((a, r) => ({
    flagged: a.flagged + (r.flagged || 0),
    confirmed: a.confirmed + (r.confirmed || 0),
    cleared: a.cleared + (r.cleared || 0),
    unmatched: a.unmatched + (r.unmatched || 0),
  }), { flagged: 0, confirmed: 0, cleared: 0, unmatched: 0 })
  for (const r of results) {
    console.log(`  ${r.exam}: flagged=${r.flagged} confirmed=${r.confirmed || 0} cleared=${r.cleared || 0} unmatched=${r.unmatched || 0}`)
  }
  console.log(`  TOTAL: flagged=${total.flagged} confirmed=${total.confirmed} cleared=${total.cleared} unmatched=${total.unmatched}`)
  if (!write && total.cleared > 0) {
    console.log(`\n(dry-run — pass --write to persist ${total.cleared} flag clears)`)
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1) })
