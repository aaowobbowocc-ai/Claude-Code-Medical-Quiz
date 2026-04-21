#!/usr/bin/env node
/**
 * Image extractor v3 — mupdf-based.
 *
 * Uses mupdf's StructuredText('preserve-images') to get text blocks and image
 * blocks with correct bounding boxes in a single pass. Renders each page to
 * a pixmap at 2x scale, then crops each image bbox and saves as WebP.
 *
 * Why re-render instead of extracting raw image bytes: mupdf gives us the
 * true on-page appearance (including any overlays/clipping), and bypasses
 * the need to handle every possible PDF image kind.
 *
 * Coordinates: mupdf uses top-left origin (y increases downward).
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
const RENDER_SCALE = 2
const MIN_IMG_DIM = 30 // skip decoratives smaller than this (in PDF points)
const MARGIN = 2 // bbox padding in PDF points to avoid cropping edge pixels

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

// ─── Extract per-PDF positions via mupdf ───
// Returns: [{pageNum, anchors: [{num, y, x}], images: [{bbox}]}]
async function extractPositions(pdfBuffer) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(pdfBuffer), 'application/pdf')
  const n = doc.countPages()
  const pages = []
  for (let i = 0; i < n; i++) {
    const pg = doc.loadPage(i)
    const st = pg.toStructuredText('preserve-images')
    const parsed = JSON.parse(st.asJSON())
    const anchors = []
    for (const b of parsed.blocks) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const txt = (ln.text || '').trim()
        const m = txt.match(/^(\d{1,3})[.．、]\s*(.*)/)
        if (!m) continue
        const num = parseInt(m[1], 10)
        if (num < 1 || num > 120) continue
        // Skip if what follows looks like a section header, e.g. "1.第一題組"
        const after = m[2]
        if (!after || after.length < 2) continue
        anchors.push({ num, y: ln.bbox.y, x: ln.bbox.x })
      }
    }
    anchors.sort((a, b) => a.y - b.y || a.x - b.x)
    // Dedupe: if the same num appears multiple times on a page (e.g. "1." in
    // both an anchor and an option somewhere), keep the earliest (smallest y)
    // which is typically the real question header.
    const dedup = new Map()
    for (const a of anchors) {
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
    pages.push({ pageNum: i + 1, width: parsed.blocks[0]?.bbox?.w, anchors: uniqAnchors, images, mupdfPage: pg })
  }
  return { doc, pages, mupdf }
}

// Match each image to the closest question anchor above it (same page), or
// fall through to the last question of the previous page.
function matchImageToQuestion(img, page, prevPages) {
  const imgTop = img.bbox.y
  const above = page.anchors.filter(a => a.y <= imgTop + 5).sort((a, b) => b.y - a.y)
  if (above.length) return above[0].num
  // Fall through: use the max question num seen on any previous page
  for (let i = prevPages.length - 1; i >= 0; i--) {
    const p = prevPages[i]
    if (p.anchors.length) return Math.max(...p.anchors.map(a => a.num))
  }
  return null
}

// ─── Render a mupdf page + crop image bbox → webp ───
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

// ─── Main: extract one PDF → write images + return mapping ───
// Returns: { [paperIdx]: { [questionNum]: ['/question-images/...', ...] } }
async function extractPaper({ exam, code, c, s, paperIdx, dryRun }) {
  const buf = await cachedPdf(exam, code, c, s)
  if (buf.length < 2000) return {}
  const { doc, pages, mupdf } = await extractPositions(buf)
  const mapping = {}
  const perQuestionCounter = new Map()
  try {
    for (let pi = 0; pi < pages.length; pi++) {
      const page = pages[pi]
      const prev = pages.slice(0, pi)
      for (const img of page.images) {
        const num = matchImageToQuestion(img, page, prev)
        if (num == null) continue
        const key = `${num}`
        const idx = perQuestionCounter.get(key) || 0
        perQuestionCounter.set(key, idx + 1)
        const fname = `${exam}_${code}_p${paperIdx}_${num}_${idx}.webp`
        const outPath = path.join(IMG_OUT, fname)
        if (!dryRun) {
          const ok = await cropImage(mupdf, page.mupdfPage, img.bbox, outPath)
          if (!ok) continue
        }
        if (!mapping[num]) mapping[num] = []
        mapping[num].push('/question-images/' + fname)
      }
    }
  } finally {
    for (const p of pages) { try { p.mupdfPage.destroy?.() } catch {} }
    try { doc.destroy?.() } catch {}
  }
  return mapping
}

// ─── Per-session driver ───
// session = { exam, code, papers: [{ c, s }] }
// returns { paperIdx: { num: [urls] } } keyed 0..n-1
async function extractSession(session, { dryRun = false } = {}) {
  const result = {}
  for (let i = 0; i < session.papers.length; i++) {
    const p = session.papers[i]
    console.log(`  paper ${i+1}: c=${p.c} s=${p.s}`)
    try {
      const mapping = await extractPaper({
        exam: session.exam, code: session.code,
        c: p.c, s: p.s, paperIdx: i, dryRun,
      })
      result[i] = mapping
      const total = Object.values(mapping).reduce((a, b) => a + b.length, 0)
      console.log(`    extracted ${total} images across ${Object.keys(mapping).length} questions`)
    } catch (e) {
      console.error(`    error: ${e.message}`)
      result[i] = {}
    }
  }
  return result
}

// ─── Test harness ───
if (require.main === module) {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')

  ;(async () => {
    // Test on dental2 110020 (the session we know has images)
    const test = {
      exam: 'dental2', code: '110020',
      papers: [
        { c: '304', s: '33' },
        { c: '304', s: '44' },
        { c: '304', s: '55' },
        { c: '304', s: '66' },
      ],
    }
    console.log(`=== ${test.exam} ${test.code} ===`)
    const r = await extractSession(test, { dryRun })
    console.log('\nFinal mapping:')
    for (const [pi, pm] of Object.entries(r)) {
      console.log(` paper ${pi}:`)
      const keys = Object.keys(pm).map(Number).sort((a, b) => a - b)
      for (const k of keys) console.log(`  Q${k}:`, pm[k])
    }
  })().catch(e => { console.error(e); process.exit(1) })
}

module.exports = { extractSession, extractPaper }
