#!/usr/bin/env node
/**
 * Fix the 5 stuck GSAT questions where parser couldn't find isolated question
 * number (likely 題組型: e.g. "第 44-46 題為題組" + shared figure).
 *
 * Strategy: render the entire PDF page that mentions the q number (in any
 * pattern incl 題組 markers), save as the question's image. User sees full
 * context with figure.
 */

const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')
const OUT_DIR = path.join(BACKEND, '..', 'frontend', 'public', 'question-images')

const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')

const STUCK = [
  { id: 'gsat_106_social_044', year: '106', subject: 'social', num: 44 },
  { id: 'gsat_108_social_030', year: '108', subject: 'social', num: 30 },
  { id: 'gsat_108_social_031', year: '108', subject: 'social', num: 31 },
  { id: 'gsat_109_social_045', year: '109', subject: 'social', num: 45 },
  { id: 'gsat_110_social_058', year: '110', subject: 'social', num: 58 },
]

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }

async function findPageForQuestion(pdfPath, qnum) {
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  // Patterns to try on each page text
  const patterns = [
    new RegExp(`(?:^|\\n)\\s*${qnum}[.、．]`),  // standalone "44."
    new RegExp(`第\\s*${qnum}[\\s-－至]`),       // "第 44 題", "第 44-46 題"
    new RegExp(`${qnum}\\s*[-－至~]\\s*\\d+\\s*題`),  // "44-46 題"
    new RegExp(`\\b${qnum}\\b`),  // any standalone occurrence
  ]
  for (let i = 0; i < doc.countPages(); i++) {
    const t = stripPUA(doc.loadPage(i).toStructuredText('preserve-whitespace').asText())
    for (const re of patterns) {
      if (re.test(t)) return { doc, idx: i }
    }
  }
  return null
}

async function renderPageToWebp(doc, idx, scale = 2) {
  const mupdf = await getMupdf()
  const page = doc.loadPage(idx)
  const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true)
  const png = Buffer.from(pixmap.asPNG())
  return sharp(png).webp({ quality: 75 }).toBuffer()
}

async function main() {
  const data = JSON.parse(fs.readFileSync(path.join(BACKEND, 'questions-gsat.json'), 'utf8'))
  const arr = data.questions || data
  let done = 0
  for (const t of STUCK) {
    const pdfPath = path.join(PDF_CACHE, `gsat_${t.year}_${t.subject}.pdf`)
    if (!fs.existsSync(pdfPath)) { console.log(`✗ ${t.id}: PDF missing`); continue }
    const info = await findPageForQuestion(pdfPath, t.num)
    if (!info) { console.log(`✗ ${t.id}: page not found`); continue }
    // Render this page + adjacent (题组 may span pages)
    const pages = [info.idx]
    if (info.idx + 1 < info.doc.countPages()) pages.push(info.idx + 1)
    const webps = []
    for (const p of pages) webps.push(await renderPageToWebp(info.doc, p))
    // Stack vertically
    const metas = await Promise.all(webps.map(w => sharp(w).metadata()))
    const totalH = metas.reduce((s, m) => s + m.height, 0)
    const maxW = Math.max(...metas.map(m => m.width))
    const composites = []
    let acc = 0
    for (let i = 0; i < webps.length; i++) {
      composites.push({ input: webps[i], top: acc, left: 0 })
      acc += metas[i].height
    }
    const combined = await sharp({ create: { width: maxW, height: totalH, channels: 3, background: '#ffffff' } })
      .composite(composites)
      .webp({ quality: 75 })
      .toBuffer()
    const fn = `gsat_${t.year}_${t.subject}_${t.num}.webp`
    fs.writeFileSync(path.join(OUT_DIR, fn), combined)
    // Update JSON
    const q = arr.find(x => x.id === t.id)
    if (q) {
      q.images = [`/question-images/${fn}`]
      delete q.image_dependent
      delete q.incomplete
      done++
      console.log(`✓ ${t.id}: ${fn} (${(combined.length/1024).toFixed(0)} KB)`)
    }
  }
  fs.writeFileSync(path.join(BACKEND, 'questions-gsat.json'), JSON.stringify(data, null, 2))
  console.log(`\n=== Done: ${done}/${STUCK.length} ===`)
}

main().catch(e => { console.error(e); process.exit(1) })
