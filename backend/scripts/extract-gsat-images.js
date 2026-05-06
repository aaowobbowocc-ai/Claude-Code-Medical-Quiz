#!/usr/bin/env node
/**
 * Extract GSAT image_dependent question images from CEEC PDFs.
 *
 * Strategy: render each question's full page strip (text + figures + options)
 * as a single webp. URLs sourced from scrape-ceec.js REGISTRY.
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const sharp = require('sharp')

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')
const OUT_DIR = path.join(BACKEND, '..', 'frontend', 'public', 'question-images')
const CEEC_BASE = 'https://www.ceec.edu.tw'

// Lazy-load REGISTRY from scrape-ceec.js by reading the file and eval'ing the const
function loadCeecRegistry() {
  const src = fs.readFileSync(path.join(__dirname, 'scrape-ceec.js'), 'utf8')
  // Match REGISTRY object up to a balanced closing brace before "const "
  const m = src.match(/const REGISTRY = ({[\s\S]+?\n});\n/)
  if (!m) throw new Error('cannot parse REGISTRY')
  return eval('(' + m[1] + ')')
}

async function get(url) {
  return new Promise(resolve => {
    const fullUrl = url.startsWith('http') ? url : CEEC_BASE + url
    https.get(fullUrl, { agent: new https.Agent({ rejectUnauthorized: false }) }, r => {
      if (r.statusCode === 301 || r.statusCode === 302) {
        return get(r.headers.location).then(resolve)
      }
      if (r.statusCode !== 200) { r.destroy(); return resolve(null) }
      const ch = []
      r.on('data', c => ch.push(c))
      r.on('end', () => resolve(Buffer.concat(ch)))
    }).on('error', () => resolve(null))
  })
}

async function ensurePdf(year, subject, registry) {
  const yr = registry.gsat?.years?.[year]
  if (!yr || !yr[subject] || !yr[subject].q) return null
  const fn = path.join(PDF_CACHE, `gsat_${year}_${subject}.pdf`)
  if (fs.existsSync(fn) && fs.statSync(fn).size > 5000) return fn
  console.log(`  downloading ${year} ${subject}...`)
  const buf = await get(yr[subject].q)
  if (!buf || buf.length < 5000) { console.log('  ✗ download failed'); return null }
  fs.writeFileSync(fn, buf)
  return fn
}

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }

const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')

async function findQuestionStarts(pdfPath) {
  // Returns map: qnum → {page, y}
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const starts = []
  for (let p = 0; p < doc.countPages(); p++) {
    const page = doc.loadPage(p)
    const json = JSON.parse(page.toStructuredText('preserve-images').asJSON())
    for (const b of (json.blocks || [])) {
      if (b.type !== 'text') continue
      const firstLine = (b.lines || [])[0]?.text || ''
      // GSAT question numbers: "1." or "1．" at start
      const m = stripPUA(firstLine).match(/^\s*(\d{1,3})[.、．]\s/)
      if (!m) continue
      const num = parseInt(m[1])
      if (num < 1 || num > 80) continue
      starts.push({ num, page: p, y: b.bbox.y })
    }
  }
  // Dedup and sort: keep smallest (page, y) per num
  const map = new Map()
  for (const s of starts) {
    const ex = map.get(s.num)
    if (!ex || s.page < ex.page || (s.page === ex.page && s.y < ex.y)) {
      map.set(s.num, s)
    }
  }
  return map
}

async function renderStrip(doc, page, y1, y2, scale = 2) {
  const mupdf = await getMupdf()
  const pg = doc.loadPage(page)
  const bounds = pg.getBounds()
  const pageW = bounds[2], pageH = bounds[3]
  const pixmap = pg.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true)
  const png = Buffer.from(pixmap.asPNG())
  const cy1 = Math.max(0, Math.floor(y1 * scale))
  const cy2 = Math.min(Math.floor(pageH * scale), Math.ceil((y2 ?? pageH) * scale))
  const meta = await sharp(png).metadata()
  return sharp(png)
    .extract({ left: 0, top: cy1, width: meta.width, height: Math.max(50, cy2 - cy1) })
    .webp({ quality: 75 })
    .toBuffer()
}

async function extractQuestionImage(pdfPath, qstart, nextStart) {
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')

  if (!nextStart || nextStart.page === qstart.page) {
    // Same page: from y to next q's y (or page bottom)
    const y2 = nextStart ? nextStart.y - 4 : null
    return renderStrip(doc, qstart.page, qstart.y - 4, y2)
  }
  // Cross-page: strip 1 from qstart.y to bottom, strip 2 from top to nextStart.y on next page
  const strips = [await renderStrip(doc, qstart.page, qstart.y - 4, null)]
  for (let p = qstart.page + 1; p < nextStart.page; p++) {
    strips.push(await renderStrip(doc, p, 0, null))
  }
  if (nextStart.page > qstart.page) {
    strips.push(await renderStrip(doc, nextStart.page, 0, nextStart.y - 4))
  }
  // Stack vertically
  const metas = await Promise.all(strips.map(s => sharp(s).metadata()))
  const totalH = metas.reduce((s, m) => s + m.height, 0)
  const maxW = Math.max(...metas.map(m => m.width))
  const composites = []
  let acc = 0
  for (let i = 0; i < strips.length; i++) {
    composites.push({ input: strips[i], top: acc, left: 0 })
    acc += metas[i].height
  }
  return sharp({ create: { width: maxW, height: totalH, channels: 3, background: '#ffffff' } })
    .composite(composites)
    .webp({ quality: 75 })
    .toBuffer()
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })

  const registry = loadCeecRegistry()
  const data = JSON.parse(fs.readFileSync(path.join(BACKEND, 'questions-gsat.json'), 'utf8'))
  const arr = data.questions || data
  const targets = arr.filter(q => q.image_dependent === true)
  console.log(`Target: ${targets.length} image_dependent questions\n`)

  // Group by (year, subject_tag)
  const groups = {}
  for (const q of targets) {
    const k = `${q.roc_year}_${q.subject_tag}`
    groups[k] = groups[k] || []
    groups[k].push(q)
  }

  let totalDone = 0, totalSkip = 0
  for (const [key, qs] of Object.entries(groups)) {
    const [year, subject] = key.split('_')
    console.log(`=== ${year} ${subject} (${qs.length} questions) ===`)
    const pdfPath = await ensurePdf(year, subject, registry)
    if (!pdfPath) { console.log('  ✗ no PDF'); totalSkip += qs.length; continue }
    const starts = await findQuestionStarts(pdfPath)
    const startsArr = [...starts.values()].sort((a, b) => a.page - b.page || a.y - b.y)
    console.log(`  parsed ${startsArr.length} question starts`)

    for (const q of qs) {
      const qstart = starts.get(q.number)
      if (!qstart) { console.log(`  ✗ Q${q.number}: not found in PDF`); totalSkip++; continue }
      // Find next question start (any number > q.number, OR the next start in sequence)
      const nextStart = startsArr.find(s => (s.page > qstart.page) || (s.page === qstart.page && s.y > qstart.y + 5))
      try {
        const webp = await extractQuestionImage(pdfPath, qstart, nextStart)
        const fn = `gsat_${year}_${subject}_${q.number}.webp`
        fs.writeFileSync(path.join(OUT_DIR, fn), webp)
        // Update JSON
        q.images = [`/question-images/${fn}`]
        delete q.image_dependent  // image now provided
        delete q.incomplete  // remove if was set
        totalDone++
        if (totalDone % 20 === 0) console.log(`  ... ${totalDone} done`)
      } catch (e) {
        console.log(`  ✗ Q${q.number}: ${e.message}`)
        totalSkip++
      }
    }
    // Save JSON intermittently
    fs.writeFileSync(path.join(BACKEND, 'questions-gsat.json'), JSON.stringify(data, null, 2))
    console.log(`  ✓ ${qs.length} processed`)
  }

  console.log(`\n=== Done: ${totalDone} extracted, ${totalSkip} skipped ===`)
}

main().catch(e => { console.error(e); process.exit(1) })
