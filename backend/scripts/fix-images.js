#!/usr/bin/env node
/**
 * Unified image remapper.
 *
 * The old extractor keyed images by question.number (within-paper 1..80),
 * which collapsed across papers — so ~75% of images ended up on the wrong
 * question in multi-paper exams. This rewrites image references by:
 *
 *   1. Downloading each candidate (c, s) PDF for the exam_code.
 *   2. Parsing each PDF with a bbox-aware, column-aware text extractor
 *      (reusing fix-truncated-questions helpers) → {num: {question, options}}.
 *   3. Text-matching each JSON question with images to the correct PDF
 *      question by normalized prefix — this tells us which paper and which
 *      in-PDF number an image question actually belongs to.
 *   4. Extracting image bboxes from that PDF and mapping each image to its
 *      nearest preceding question anchor on the same page.
 *   5. Cropping the image from a freshly-rendered page pixmap and writing it
 *      to `{exam}_{code}_{globalIdx}_{imgIdx}.webp` — same naming as before,
 *      but now globally unique per JSON question instead of colliding across
 *      papers.
 *   6. Replacing the JSON `images` array with the new paths.
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const sharp = require('sharp')

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')
const IMG_OUT = path.join(__dirname, '..', '..', 'frontend', 'public', 'question-images')
const PROBE_CACHE_FILE = path.join(__dirname, '..', '_tmp', 'probe-results.json')
const RENDER_SCALE = 2
const MIN_IMG_DIM = 30
const MARGIN = 2

fs.mkdirSync(PDF_CACHE, { recursive: true })
fs.mkdirSync(IMG_OUT, { recursive: true })

// ─── PDF download (cached) ───
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
async function cachedPdf(exam, code, c, s) {
  const key = `${exam}_${code}_c${c}_s${s}.pdf`
  const p = path.join(PDF_CACHE, key)
  if (fs.existsSync(p) && fs.statSync(p).size > 1000) return fs.readFileSync(p)
  const url = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
  const buf = await fetchPdf(url)
  fs.writeFileSync(p, buf)
  return buf
}

// ─── Probe (reuses cache) ───
let probeCache = {}
try { probeCache = JSON.parse(fs.readFileSync(PROBE_CACHE_FILE, 'utf8')) } catch {}
function saveProbeCache() {
  try { fs.writeFileSync(PROBE_CACHE_FILE, JSON.stringify(probeCache, null, 2)) } catch {}
}
const CANDIDATE_SUBJECT_CODES = [
  '11', '22', '33', '44', '55', '66', '77', '88',
  '0101', '0102', '0103', '0104', '0105', '0106',
  '0201', '0202', '0203', '0204', '0205', '0206',
  '0301', '0302', '0303', '0304', '0305', '0306',
  '0401', '0402', '0403', '0404', '0405', '0406',
]
async function probeSubjectCodes(exam, code, classCode) {
  const k = `${exam}_${code}`
  if (probeCache[k]) return probeCache[k]
  const found = []
  for (const s of CANDIDATE_SUBJECT_CODES) {
    try {
      const buf = await cachedPdf(exam, code, classCode, s)
      if (buf && buf.length > 100000) found.push(s)
    } catch {}
  }
  probeCache[k] = found
  saveProbeCache()
  return found
}

// ─── Column-aware text extraction (from fix-truncated-questions) ───
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

function parseQuestions(fullText) {
  const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean)
  const out = {}
  let cur = null, curOpt = null, qBuf = [], optBuf = ''
  let pendingNum = null // for "\d+." alone at end of page
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
    // Orphan question header like "52." with no content (happens at page
    // break). Remember it and apply to next non-empty, non-header line.
    const mBare = ln.match(/^(\d{1,3})[.．、]\s*$/)
    if (mBare) {
      const n = +mBare[1]
      if (n >= 1 && n <= 120) { pendingNum = n; continue }
    }
    if (pendingNum != null) {
      const n = pendingNum
      pendingNum = null
      // Skip A-D option lines and bare numeric noise — they can't be the
      // question stem.
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

function normText(t) {
  return (t || '').normalize('NFKC')
    .replace(/[\s,，、.。;；:：!！?？（）()\[\]【】{}「」『』"'"'“”‘’\-_—–~`]/g, '')
    .toLowerCase()
}

function findMatch(jsonQ, pdfIndex) {
  const qn = normText(jsonQ.question)
  const prefix = qn.slice(0, Math.min(15, qn.length))
  if (!prefix) return null
  for (const [num, pdfQ] of Object.entries(pdfIndex)) {
    const pn = normText(pdfQ.question)
    if (pn.startsWith(prefix) || pn.includes(prefix)) return { num: +num, pdfQ }
  }
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

// ─── Extract both text and image positions in one pass ───
// Returns: {
//   textIndex: {num: {question, options}},
//   pages: [{mupdfPage, anchors, images}],
//   doc, mupdf
// }
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
      images.push({ bbox: bb })
    }
    pages.push({ pageNum: i + 1, anchors: uniqAnchors, images, mupdfPage: pg })
  }
  const textIndex = parseQuestions(fullText)
  return { textIndex, pages, doc, mupdf }
}

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

async function cropImage(mupdf, page, bbox, outPath) {
  const m = mupdf.Matrix.scale(RENDER_SCALE, RENDER_SCALE)
  const pixmap = page.toPixmap(m, mupdf.ColorSpace.DeviceRGB, false)
  const png = Buffer.from(pixmap.asPNG())
  const pw = pixmap.getWidth()
  const ph = pixmap.getHeight()
  const left = Math.max(0, Math.floor((bbox.x - MARGIN) * RENDER_SCALE))
  const top = Math.max(0, Math.floor((bbox.y - MARGIN) * RENDER_SCALE))
  const right = Math.min(pw, Math.ceil((bbox.x + bbox.w + MARGIN) * RENDER_SCALE))
  const bottom = Math.min(ph, Math.ceil((bbox.y + bbox.h + MARGIN) * RENDER_SCALE))
  const width = right - left
  const height = bottom - top
  if (width < 10 || height < 10) return false
  await sharp(png)
    .extract({ left, top, width, height })
    .webp({ quality: 82 })
    .toFile(outPath)
  return true
}

// ─── Exam registry ───
const EXAM_PAPERS = {
  doctor1: { file: 'questions.json', classCode: '301' },
  doctor2: { file: 'questions-doctor2.json', classCode: '302' },
  dental1: { file: 'questions-dental1.json', classCode: '303' },
  dental2: { file: 'questions-dental2.json', classCode: '304' },
  pharma1: { file: 'questions-pharma1.json', classCode: '305' },
  pharma2: { file: 'questions-pharma2.json', classCode: '306' },
}

// Process one (exam, code): returns stats
async function fixExamCode(examTag, code, opts) {
  const def = EXAM_PAPERS[examTag]
  const file = path.join(__dirname, '..', def.file)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const qs = Array.isArray(raw) ? raw : raw.questions
  const imgQs = qs.filter(q => q.exam_code === code && q.images && q.images.length)
  if (!imgQs.length) return { matched: 0, unmatched: 0, replaced: 0 }

  const codes = await probeSubjectCodes(examTag, code, def.classCode)
  if (!codes.length) { console.log(`  no PDFs for ${examTag} ${code}`); return { matched: 0, unmatched: 0, replaced: 0 } }

  // Parse each PDF
  const pdfs = []
  for (const s of codes) {
    try {
      const buf = await cachedPdf(examTag, code, def.classCode, s)
      if (buf.length < 2000) continue
      const parsed = await parsePdfFull(buf)
      pdfs.push({ s, ...parsed })
    } catch (e) { console.error(`    parse ${s} failed: ${e.message}`) }
  }
  if (!pdfs.length) return { matched: 0, unmatched: 0, replaced: 0 }

  // For each PDF, build {pdfNum: [imageBboxes]}
  for (const pdf of pdfs) {
    pdf.imagesPerNum = {}
    for (let pi = 0; pi < pdf.pages.length; pi++) {
      const page = pdf.pages[pi]
      const prev = pdf.pages.slice(0, pi)
      for (const img of page.images) {
        const num = matchImageToPdfNum(img, page, prev)
        if (num == null) continue
        if (!pdf.imagesPerNum[num]) pdf.imagesPerNum[num] = []
        pdf.imagesPerNum[num].push({ page: page.mupdfPage, bbox: img.bbox })
      }
    }
  }

  let matched = 0, unmatched = 0, replaced = 0, cleared = 0
  try {
    for (const q of imgQs) {
      // Find which PDF this question belongs to
      let hit = null
      for (const pdf of pdfs) {
        const m = findMatch(q, pdf.textIndex)
        if (m) { hit = { pdf, num: m.num }; break }
      }
      if (!hit) {
        unmatched++
        if (opts.dryRun) console.log(`  [???] ${q.id} ${(q.question || '').slice(0, 30)}`)
        continue
      }
      matched++
      const pdfImgs = hit.pdf.imagesPerNum[hit.num] || []
      if (!pdfImgs.length) {
        // PDF matched but has no image for that number → the old extractor
        // wrongly tagged this question with an image. Clear the array.
        if (opts.dryRun) console.log(`  [clr] ${q.id}`)
        else q.images = []
        cleared++
        continue
      }
      // Use the full question id to avoid collisions across papers with
      // duplicate within-paper numbers (e.g. paper1 Q17 vs paper2 Q17).
      const newPaths = []
      for (let i = 0; i < pdfImgs.length; i++) {
        const fname = `${examTag}_${q.id}_${i}.webp`
        const outPath = path.join(IMG_OUT, fname)
        if (!opts.dryRun) {
          const ok = await cropImage(hit.pdf.mupdf, pdfImgs[i].page, pdfImgs[i].bbox, outPath)
          if (!ok) continue
        }
        newPaths.push('/question-images/' + fname)
      }
      if (newPaths.length) {
        const old = JSON.stringify(q.images)
        const nu = JSON.stringify(newPaths)
        if (old !== nu) {
          replaced++
          if (opts.dryRun) console.log(`  [dry] ${q.id}: ${old} → ${nu}`)
          else q.images = newPaths
        }
      }
    }
  } finally {
    for (const pdf of pdfs) {
      for (const p of pdf.pages) { try { p.mupdfPage.destroy?.() } catch {} }
      try { pdf.doc.destroy?.() } catch {}
    }
  }

  if (!opts.dryRun && (replaced > 0 || cleared > 0)) {
    fs.writeFileSync(file, JSON.stringify(raw, null, 2))
  }
  console.log(`  ${examTag} ${code}: matched=${matched} unmatched=${unmatched} replaced=${replaced} cleared=${cleared}`)
  return { matched, unmatched, replaced, cleared }
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const filterExam = args.find(a => a.startsWith('--exam='))?.slice(7)
  const filterCode = args.find(a => a.startsWith('--code='))?.slice(7)

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
      if (q.images && q.images.length) codes.add(q.exam_code)
    }
    for (const code of [...codes].sort()) targets.push({ examTag, code })
  }

  console.log(`Targets: ${targets.length}`)
  const agg = { matched: 0, unmatched: 0, replaced: 0, cleared: 0 }
  for (const t of targets) {
    console.log(`=== ${t.examTag} ${t.code} ===`)
    try {
      const r = await fixExamCode(t.examTag, t.code, { dryRun })
      agg.matched += r.matched; agg.unmatched += r.unmatched
      agg.replaced += r.replaced; agg.cleared += r.cleared || 0
    } catch (e) { console.error(`  error: ${e.message}`) }
  }
  console.log(`\nTotal: matched=${agg.matched} unmatched=${agg.unmatched} replaced=${agg.replaced} cleared=${agg.cleared}`)
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1) })
