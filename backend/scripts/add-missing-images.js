#!/usr/bin/env node
/**
 * Add-missing-images sweep.
 *
 * Counterpart to fix-images.js. Where that script *re-routes* existing image
 * associations, this one *adds* image entries for questions that strictly
 * reference a figure ("附圖/如圖/下圖/上圖/圖中/圖示") but have no `images`
 * field. Reuses fix-images.js helpers so behavior matches the existing
 * extraction pipeline 1:1.
 *
 * Flow per (exam, exam_code):
 *   1. Probe candidate subject codes for valid PDFs (cached).
 *   2. Parse each PDF to extract per-question text + image bboxes.
 *   3. For each JSON question with strict image refs but empty `images`:
 *        - Text-match against the PDF question index (any paper)
 *        - Look up the matched PDF question's images
 *        - Crop each image and save as `${exam}_{q.id}_{i}.webp`
 *        - Set q.images = [paths]
 *
 * Idempotent: skips questions that already have images.
 */

const fs = require('fs')
const path = require('path')

const STRICT = /附圖|如圖|圖示|下圖|上圖|圖中|圖為|如下圖|如上圖|根據圖|見圖|圖所示/

// We reach into fix-images.js by re-requiring its module after monkey-patching.
// Easiest: copy the helpers we need here. Avoid duplicating code by exporting
// them from fix-images.js… but fix-images.js currently has no exports. To keep
// this self-contained, this script duplicates the small parsing helpers and
// then re-uses the WebP cropper logic.

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

// ─── HTTP ───
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

// ─── Probe ───
let probeCache = {}
try { probeCache = JSON.parse(fs.readFileSync(PROBE_CACHE_FILE, 'utf8')) } catch {}
function saveProbeCache() {
  try { fs.writeFileSync(PROBE_CACHE_FILE, JSON.stringify(probeCache, null, 2)) } catch {}
}
const CANDIDATE_SUBJECT_CODES = [
  '11', '22', '33', '44', '55', '66', '77', '88',
  '0101', '0102', '0103', '0104', '0105', '0106', '0107',
  '0201', '0202', '0203', '0204', '0205', '0206',
  '0301', '0302', '0303', '0304', '0305', '0306',
  '0401', '0402', '0403', '0404', '0405', '0406',
  '0501', '0502', '0503', '0504', '0505',
  '0701', '0702', '0703', '0704', '0705', '0706',
  '0801', '0802', '0803', '0804', '0805',
  '1001', '1002', '1003', '1004', '1005', '1006',
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

// ─── Text + image parsing (mirrors fix-images.js) ───
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
        if (lastCh && lastCh === firstCh && !/\s/.test(lastCh)) merged = mTrim + tTrim.slice(1)
        else merged += t
      } else merged += t
    }
    return merged.trim()
  }).join('\n')
}

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

function normText(t) {
  return (t || '').normalize('NFKC')
    .replace(/[\s,，、.。;；:：!！?？（）()\[\]【】{}「」『』"'"'"""''\-_—–~`]/g, '')
    .toLowerCase()
}

function findMatch(jsonQ, pdfIndex) {
  const qn = normText(jsonQ.question)
  // Strip the carry-over context block we added in bind-carryover-questions.js
  // so the prefix actually matches the PDF text.
  const stripped = qn.replace(/^.*──────────/s, '')
  const candidate = stripped || qn
  const prefix = candidate.slice(0, Math.min(15, candidate.length))
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
      if (pA.startsWith(optA) && pn.includes(candidate.slice(0, 5))) return { num: +num, pdfQ }
    }
  }
  return null
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
// Static class codes (no per-year variance): use as primary; fall back to
// probing alternates only if the static one yields no PDFs.
//
// `examName` is the exact 類科 string printed on the official PDF — used to
// validate that a cached/downloaded PDF actually belongs to this exam. Without
// this check, scripts blindly trusted the cached `c{NN}` filename and picked
// up the wrong-exam PDFs from earlier years where the same class code was
// reused for a different 類科 (e.g. nursing 030-c=101 in 110/111 is actually
// 中醫師, not 護理師).
const EXAM_REGISTRY = {
  doctor1:   { file: 'questions.json',           classCodes: ['301'], examName: '醫師' },
  doctor2:   { file: 'questions-doctor2.json',   classCodes: ['302'], examName: '醫師' },
  dental1:   { file: 'questions-dental1.json',   classCodes: ['303'], examName: '牙醫師' },
  dental2:   { file: 'questions-dental2.json',   classCodes: ['304'], examName: '牙醫師' },
  pharma1:   { file: 'questions-pharma1.json',   classCodes: ['305'], examName: '藥師' },
  pharma2:   { file: 'questions-pharma2.json',   classCodes: ['306'], examName: '藥師' },
  nursing:   { file: 'questions-nursing.json',   classCodes: ['101', '102', '104'], examName: '護理師' },
  nutrition: { file: 'questions-nutrition.json', classCodes: ['101', '102'],        examName: '營養師' },
  medlab:    { file: 'questions-medlab.json',    classCodes: ['308'], examName: '醫事檢驗師' },
  pt:        { file: 'questions-pt.json',        classCodes: ['311'], examName: '物理治療師' },
  ot:        { file: 'questions-ot.json',        classCodes: ['312'], examName: '職能治療師' },
  vet:       { file: 'questions-vet.json',       classCodes: ['314'], examName: '獸醫師' },
  tcm1:      { file: 'questions-tcm1.json',      classCodes: ['317'], examName: '中醫師' },
  tcm2:      { file: 'questions-tcm2.json',      classCodes: ['318'], examName: '中醫師' },
}

// Read the 類科 line from the first page of a PDF buffer. Returns null on
// failure. The official 考選部 試題 PDF always prints
// 「類科：護理師」 (or similar) near the top of page 1, so checking against
// EXAM_REGISTRY[exam].examName proves the file actually belongs to that exam
// and not a same-class-code from a different year.
async function pdfExamName(buf) {
  try {
    const mupdf = await import('mupdf')
    const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
    const parsed = JSON.parse(doc.loadPage(0).toStructuredText('preserve-images').asJSON())
    let txt = ''
    for (const b of parsed.blocks || []) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) txt += (ln.text || '') + '\n'
    }
    // Match across line breaks. Two layouts exist on moex:
    //   old: "類　科：護理師"        → strips to 類科：護理師
    //   new: "類科名稱：中醫師(一)"   → strips to 類科名稱：中醫師(一)
    // Accept an optional 名稱 between 類科 and the colon, and allow CJK
    // brackets / arabic digits in the captured name (covers 中醫師(一) etc).
    const compact = txt.replace(/\s+/g, '')
    const m = compact.match(/類科(?:名稱)?[：:]([\u4e00-\u9fff()（）]{2,12})/)
    return m ? m[1] : null
  } catch { return null }
}

async function pdfMatchesExam(buf, examName) {
  if (!buf || !examName) return false
  const found = await pdfExamName(buf)
  if (!found) return false
  // Loose match: PDF 類科 must contain or equal the registry name (e.g. some
  // PDFs print "醫師" while others print "醫師(臨床)").
  return found.includes(examName) || examName.includes(found)
}

// Pick the working classCode for (exam, exam_code). For each candidate we:
//   1. Look at any cached PDF with that c-code
//   2. Verify its 類科 line actually matches this exam (otherwise the cache
//      is stale data from another exam that reused the code)
//   3. If no cached file passes, probe-download one subject code and verify
async function pickClassCode(examTag, code, candidates) {
  const expectedName = EXAM_REGISTRY[examTag]?.examName
  for (const c of candidates) {
    // Try every cached file with this class code (both naming conventions:
    // {exam}_{code}_c{c}_s{s}.pdf and {exam}_Q_{code}_c{c}_s{s}.pdf)
    const cachedFiles = fs.readdirSync(PDF_CACHE).filter(f =>
      (f.startsWith(`${examTag}_${code}_c${c}_`) || f.startsWith(`${examTag}_Q_${code}_c${c}_`))
      && f.endsWith('.pdf')
      && fs.statSync(path.join(PDF_CACHE, f)).size > 100000
    )
    let validatedFromCache = false
    for (const f of cachedFiles) {
      const buf = fs.readFileSync(path.join(PDF_CACHE, f))
      if (await pdfMatchesExam(buf, expectedName)) { validatedFromCache = true; break }
    }
    if (validatedFromCache) return c
    // No cached file matched → probe-download a few common subject codes and
    // verify against expected exam name. Only return this c if at least one
    // probe actually contains the right exam.
    for (const probeS of ['0101', '0201', '0301', '11', '0501', '0701', '1001']) {
      try {
        const buf = await cachedPdf(examTag, code, c, probeS)
        if (buf && buf.length > 100000 && await pdfMatchesExam(buf, expectedName)) return c
      } catch {}
    }
  }
  return null
}

async function processExamCode(examTag, code, opts) {
  const def = EXAM_REGISTRY[examTag]
  const file = path.join(__dirname, '..', def.file)
  if (!fs.existsSync(file)) return { added: 0, skipped: 0 }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const qs = Array.isArray(raw) ? raw : raw.questions

  // Candidate questions: same exam_code, no images, and either:
  //   (default)        strict 圖 reference in stem/options, OR
  //   (blank-options)  any option is empty (likely image-based answer choices), OR
  //   (auto)           any question without images — relies on text-match + actual
  //                    PDF image presence to gate attachment (no false positives
  //                    because pdfImgs.length must be ≥ 1)
  const isBlank = q => ['A','B','C','D'].some(k => !q.options?.[k] || !q.options[k].trim())
  let filter
  if (opts.mode === 'blank-options') {
    filter = q => q.exam_code === code && (!q.images || !q.images.length) && isBlank(q)
  } else if (opts.mode === 'auto') {
    filter = q => q.exam_code === code && (!q.images || !q.images.length)
  } else {
    filter = q => q.exam_code === code && (!q.images || !q.images.length) &&
            STRICT.test((q.question || '') + ' ' + Object.values(q.options || {}).join(' '))
  }
  const candidates = qs.filter(filter)
  if (!candidates.length) return { added: 0, skipped: 0 }

  // Find working classCode
  const classCode = await pickClassCode(examTag, code, def.classCodes)
  if (!classCode) {
    console.log(`  ${examTag} ${code}: no working class code from ${def.classCodes.join('/')}`)
    return { added: 0, skipped: 0 }
  }

  // Probe subject codes
  const subjectCodes = await probeSubjectCodes(examTag, code, classCode)
  if (!subjectCodes.length) {
    console.log(`  ${examTag} ${code} c${classCode}: no PDFs found`)
    return { added: 0, skipped: 0 }
  }

  // Parse each PDF
  const pdfs = []
  for (const s of subjectCodes) {
    try {
      const buf = await cachedPdf(examTag, code, classCode, s)
      if (buf.length < 2000) continue
      const parsed = await parsePdfFull(buf)
      pdfs.push({ s, classCode, ...parsed })
    } catch (e) { console.error(`    parse ${s} failed: ${e.message}`) }
  }
  if (!pdfs.length) return { added: 0, skipped: 0 }

  // Build {pdfNum: [imageBboxes]} for each PDF
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

  let added = 0, skipped = 0
  try {
    for (const q of candidates) {
      let hit = null
      for (const pdf of pdfs) {
        const m = findMatch(q, pdf.textIndex)
        if (m) { hit = { pdf, num: m.num }; break }
      }
      if (!hit) { skipped++; continue }
      const pdfImgs = hit.pdf.imagesPerNum[hit.num] || []
      if (!pdfImgs.length) { skipped++; continue }
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
        if (!opts.dryRun) q.images = newPaths
        added++
        if (opts.verbose) console.log(`  + ${q.id}: ${newPaths.length} img`)
      }
    }
  } finally {
    for (const pdf of pdfs) {
      for (const p of pdf.pages) { try { p.mupdfPage.destroy?.() } catch {} }
      try { pdf.doc.destroy?.() } catch {}
    }
  }

  if (!opts.dryRun && added > 0) {
    if (raw.metadata) raw.metadata.last_updated = new Date().toISOString()
    fs.writeFileSync(file, JSON.stringify(raw, null, 2))
  }
  console.log(`  ${examTag} ${code}: added=${added} skipped=${skipped}`)
  return { added, skipped }
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const verbose = args.includes('--verbose')
  const filterExam = args.find(a => a.startsWith('--exam='))?.slice(7)
  const filterCode = args.find(a => a.startsWith('--code='))?.slice(7)
  const mode = args.find(a => a.startsWith('--mode='))?.slice(7) || 'strict'

  const isBlank = q => ['A','B','C','D'].some(k => !q.options?.[k] || !q.options[k].trim())

  // Build target list: per (examTag, exam_code) where ≥1 candidate question exists
  const targets = []
  for (const [examTag, def] of Object.entries(EXAM_REGISTRY)) {
    if (filterExam && filterExam !== examTag) continue
    const file = path.join(__dirname, '..', def.file)
    if (!fs.existsSync(file)) continue
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const qs = Array.isArray(raw) ? raw : raw.questions
    const codes = new Set()
    for (const q of qs) {
      if (filterCode && filterCode !== q.exam_code) continue
      if (!q.exam_code) continue
      if (q.images && q.images.length) continue
      if (mode === 'blank-options') {
        if (isBlank(q)) codes.add(q.exam_code)
      } else if (mode === 'auto') {
        codes.add(q.exam_code)
      } else {
        const txt = (q.question || '') + ' ' + Object.values(q.options || {}).join(' ')
        if (STRICT.test(txt)) codes.add(q.exam_code)
      }
    }
    for (const code of [...codes].sort()) targets.push({ examTag, code })
  }

  console.log(`Targets: ${targets.length}${dryRun ? ' (dry-run)' : ''} mode=${mode}`)
  let totalAdded = 0, totalSkipped = 0
  for (const t of targets) {
    console.log(`=== ${t.examTag} ${t.code} ===`)
    try {
      const r = await processExamCode(t.examTag, t.code, { dryRun, verbose, mode })
      totalAdded += r.added
      totalSkipped += r.skipped
    } catch (e) { console.error(`  error: ${e.message}`) }
  }
  console.log(`\nTotal: added=${totalAdded} skipped=${totalSkipped}`)
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1) })
