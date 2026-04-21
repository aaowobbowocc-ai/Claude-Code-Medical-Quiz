#!/usr/bin/env node
/**
 * Image extractor v2 — replaces the flawed extractor from commit 8141471
 *
 * Uses pdfjs-dist to get positioned text and image XObjects per page.
 * Matches each image to the question whose y-range contains the image.
 *
 * Output:
 *   - WebP files under frontend/public/question-images/
 *   - Updated questions-*.json with correct `images` arrays
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

// ─── pdfjs extraction per PDF ───
let pdfjsMod = null
async function pdfjs() {
  if (!pdfjsMod) pdfjsMod = await import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfjsMod
}

// Parse a PDF → array of {pageNum, width, height, questionAnchors, images}
// questionAnchors: [{num, x, y}] — y is PDFjs coordinate (bottom-up, points)
// images: [{x, y, w, h, name, dataPromise}]
async function extractPdf(buffer) {
  const { getDocument, OPS } = await pdfjs()
  const doc = await getDocument({ data: new Uint8Array(buffer), verbosity: 0 }).promise
  console.log(`    PDF loaded: ${doc.numPages} pages`)
  const pages = []
  for (let pn = 1; pn <= doc.numPages; pn++) {
    process.stdout.write(`    page ${pn}/${doc.numPages}\r`)
    const page = await doc.getPage(pn)
    const viewport = page.getViewport({ scale: 1 })
    const [pw, ph] = [viewport.width, viewport.height]

    // Text → question anchors
    const tc = await page.getTextContent()
    const items = tc.items || []
    // items[i]: { str, transform: [a,b,c,d,e,f], width, height }
    // y = transform[5]
    const anchors = []
    // Merge consecutive text in same y row to catch "1." split across items
    // Gather positional text
    const rows = []
    for (const it of items) {
      if (!it.str) continue
      const x = it.transform[4]
      const y = it.transform[5]
      rows.push({ str: it.str, x, y, h: it.height || 0 })
    }
    // Sort by y desc (top to bottom), x asc
    rows.sort((a, b) => b.y - a.y || a.x - b.x)
    // Build left-column lines: group by y (tolerance 2pt)
    const grouped = []
    for (const r of rows) {
      const last = grouped[grouped.length - 1]
      if (last && Math.abs(last.y - r.y) < 2) {
        last.items.push(r)
      } else {
        grouped.push({ y: r.y, items: [r] })
      }
    }
    // Find question anchors: line starts with N. or N、 where N is 1-120
    const questionRe = /^(\d{1,3})[.．、]\s*/
    for (const g of grouped) {
      // Join by x order
      g.items.sort((a, b) => a.x - b.x)
      const line = g.items.map(i => i.str).join('').trim()
      const m = line.match(questionRe)
      if (m) {
        const num = parseInt(m[1], 10)
        if (num >= 1 && num <= 120) {
          const x = g.items[0].x
          anchors.push({ num, x, y: g.y })
        }
      }
    }

    // Images via operator list
    const opList = await page.getOperatorList()
    const imgs = []
    // Track the graphics state stack for current transform
    // Simplified: maintain ctm via save/restore + transform ops
    const ctmStack = [[1, 0, 0, 1, 0, 0]]
    const multiply = (a, b) => [
      a[0]*b[0] + a[1]*b[2],
      a[0]*b[1] + a[1]*b[3],
      a[2]*b[0] + a[3]*b[2],
      a[2]*b[1] + a[3]*b[3],
      a[4]*b[0] + a[5]*b[2] + b[4],
      a[4]*b[1] + a[5]*b[3] + b[5],
    ]
    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i]
      const args = opList.argsArray[i]
      if (fn === OPS.save) {
        ctmStack.push([...ctmStack[ctmStack.length - 1]])
      } else if (fn === OPS.restore) {
        if (ctmStack.length > 1) ctmStack.pop()
      } else if (fn === OPS.transform) {
        const top = ctmStack[ctmStack.length - 1]
        const nt = multiply(args, top)
        ctmStack[ctmStack.length - 1] = nt
      } else if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject || fn === OPS.paintImageXObjectRepeat) {
        const name = args[0]
        const t = ctmStack[ctmStack.length - 1]
        // In PDF, a 1x1 image is drawn via ctm [w, 0, 0, h, x, y] where y is baseline
        const x = t[4]
        const y = t[5]
        const w = Math.abs(t[0])
        const h = Math.abs(t[3])
        imgs.push({ name, x, y, w, h, pageNum: pn })
      }
    }

    // Extract image data for each img via page.objs / commonObjs
    async function getImageData(name) {
      return new Promise((resolve) => {
        try {
          // Try page.objs first
          page.objs.get(name, (obj) => resolve(obj))
        } catch {
          try { page.commonObjs.get(name, (obj) => resolve(obj)) } catch { resolve(null) }
        }
      })
    }
    for (const img of imgs) {
      img.getData = () => getImageData(img.name)
    }

    pages.push({ pageNum: pn, width: pw, height: ph, anchors, images: imgs })
    page.cleanup()
  }
  await doc.destroy()
  return pages
}

// Match image to question: image belongs to the question whose y-anchor is
// >= image top (since PDF y is bottom-up, question header is above image).
// Assuming questions flow top→bottom on each page.
function matchImageToQuestion(img, pageAnchors, allPagesAnchors, pageIdx) {
  // Find the question whose header is at y >= img.y + img.h  (above the image)
  // and is the closest one.
  const imgTop = img.y + img.h
  // Anchors on the same page, y desc
  const sorted = [...pageAnchors].sort((a, b) => b.y - a.y)
  let best = null
  for (const a of sorted) {
    if (a.y >= imgTop - 5) {
      // This anchor is at or above the image top
      if (!best || a.y < best.y) best = a  // Take the LOWEST anchor above image
    }
  }
  if (best) return best
  // If no anchor on this page, use the last question from the previous page
  if (pageIdx > 0) {
    const prev = allPagesAnchors[pageIdx - 1]
    if (prev.length) {
      const maxNum = Math.max(...prev.map(a => a.num))
      return { num: maxNum, fromPrevPage: true }
    }
  }
  return null
}

// ─── Save image data as WebP via sharp ───
async function saveImageAsWebp(imgObj, outPath) {
  if (!imgObj) return false
  try {
    // pdfjs image object can be: { data: Uint8Array|Uint8ClampedArray, width, height, kind }
    // kind: 1=GRAYSCALE_1BPP, 2=RGB_24BPP, 3=RGBA_32BPP
    // OR: { bitmap: ImageBitmap } (pdfjs 4+ sometimes)
    // OR: raw JPEG bytes in some cases
    if (imgObj.bitmap) {
      // bitmap case — get via canvas (not available in node)
      // fallback: try data
    }
    let data = imgObj.data
    let width = imgObj.width
    let height = imgObj.height
    const kind = imgObj.kind
    if (!data || !width || !height) return false

    let channels, raw
    if (kind === 1) {
      // GRAYSCALE_1BPP — expand to RGB
      const rgb = Buffer.alloc(width * height * 3)
      for (let i = 0; i < width * height; i++) {
        const bit = (data[i >> 3] >> (7 - (i & 7))) & 1
        const v = bit ? 255 : 0
        rgb[i*3] = v; rgb[i*3+1] = v; rgb[i*3+2] = v
      }
      raw = rgb; channels = 3
    } else if (kind === 2) {
      raw = Buffer.from(data); channels = 3
    } else if (kind === 3) {
      raw = Buffer.from(data); channels = 4
    } else {
      // Unknown — try to infer from size
      const px = width * height
      if (data.length === px * 3) { raw = Buffer.from(data); channels = 3 }
      else if (data.length === px * 4) { raw = Buffer.from(data); channels = 4 }
      else if (data.length === px) {
        // grayscale
        const rgb = Buffer.alloc(px * 3)
        for (let i = 0; i < px; i++) { rgb[i*3]=data[i]; rgb[i*3+1]=data[i]; rgb[i*3+2]=data[i] }
        raw = rgb; channels = 3
      } else {
        return false
      }
    }

    await sharp(raw, { raw: { width, height, channels } })
      .webp({ quality: 82 })
      .toFile(outPath)
    return true
  } catch (e) {
    console.error('  save err:', e.message)
    return false
  }
}

// ─── Main per-session extraction ───
async function extractSession({ exam, code, papers }) {
  console.log(`\n=== ${exam} ${code} ===`)
  const result = { extracted: [], mappings: {} }
  for (const p of papers) {
    const { c, s } = p
    console.log(`  fetching c=${c} s=${s}…`)
    let buf
    try { buf = await cachedPdf(exam, code, c, s) } catch (e) { console.log('  fetch err:', e.message); continue }
    if (buf.length < 2000) { console.log('  too small'); continue }
    let pages
    try { pages = await extractPdf(buf) } catch (e) { console.log('  parse err:', e.message); continue }
    const allAnchors = pages.map(pg => pg.anchors)
    let totalImgs = 0
    for (let pi = 0; pi < pages.length; pi++) {
      const pg = pages[pi]
      for (const img of pg.images) {
        if (img.w < 30 || img.h < 30) continue // skip tiny decoratives
        const match = matchImageToQuestion(img, pg.anchors, allAnchors, pi)
        if (!match) continue
        const data = await img.getData()
        if (!data) continue
        totalImgs++
        const existing = result.extracted.filter(e => e.questionNum === match.num).length
        const fname = `${exam}_${code}_${match.num}_${existing}.webp`
        const outPath = path.join(IMG_OUT, fname)
        const ok = await saveImageAsWebp(data, outPath)
        if (ok) {
          result.extracted.push({ questionNum: match.num, file: fname, page: pg.pageNum, y: img.y, w: img.w, h: img.h })
          if (!result.mappings[match.num]) result.mappings[match.num] = []
          result.mappings[match.num].push('/question-images/' + fname)
        }
      }
    }
    console.log(`  pages=${pages.length} images=${totalImgs}`)
  }
  return result
}

// ─── Test harness: run dental2 110020 ───
if (require.main === module) {
  ;(async () => {
    const testSession = {
      exam: 'dental2',
      code: '110020',
      papers: [
        { c: '303', s: '11' },
        { c: '303', s: '22' },
        { c: '304', s: '33' },
        { c: '304', s: '44' },
      ],
    }
    const r = await extractSession(testSession)
    console.log('\nmappings:')
    const keys = Object.keys(r.mappings).map(Number).sort((a,b)=>a-b)
    for (const k of keys) console.log(` Q${k}:`, r.mappings[k])
    console.log(`\nTotal: ${r.extracted.length} images across ${keys.length} questions`)
  })().catch(e => { console.error(e); process.exit(1) })
}

module.exports = { extractSession, extractPdf, cachedPdf }
