#!/usr/bin/env node
/**
 * Render the 3 stubborn questions' PDF pages to PNG for manual transcription.
 */

const fs = require('fs')
const path = require('path')

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')
const OUT_DIR = path.join(BACKEND, '_tmp', 'stubborn')

const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })

const TARGETS = [
  { name: 'medlab_100-2_臨床生理病理_Q44', prefix: 'medlab_100140', subjectKw: '臨床生理', q: 44 },
  { name: 'audiologist_110-2_基礎聽力_Q5', prefix: 'audiologist_110111', subjectKw: '基礎聽力科學', q: 5 },
  { name: 'audiologist_111-2_輔具_Q7', prefix: 'audiologist_111110', subjectKw: '聽覺輔具', q: 7 },
]

async function readPdfText(p) {
  const mupdf = await import('mupdf')
  const buf = fs.readFileSync(p)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) txt += '\n[[P' + (i + 1) + ']]\n' + doc.loadPage(i).toStructuredText('preserve-whitespace').asText()
  return { txt: stripPUA(txt), doc }
}

async function findCorrectPdf(prefix, kw) {
  const files = fs.readdirSync(PDF_CACHE).filter(f =>
    f.startsWith(prefix) && f.endsWith('.pdf')
    && !f.startsWith('A_') && !f.startsWith('TS_') && !f.startsWith('TM_')
    && !f.endsWith('_S.pdf')
  )
  for (const f of files) {
    const p = path.join(PDF_CACHE, f)
    const { txt } = await readPdfText(p)
    if (txt.includes(kw)) return p
  }
  return null
}

async function findAnswer(pdfPath, qnum) {
  // Find paired answer PDF (TS_ or _S.pdf or A_)
  const fname = path.basename(pdfPath)
  const m = fname.match(/_c(\w+)_s(\w+?)(?:_Q)?\.pdf$/)
  if (!m) return null
  const [, c, s] = m
  const code = fname.match(/^[a-z-]+_(\d+)_/)?.[1]
  const candidates = [
    `TS_${code}_c${c}_s${s}.pdf`,
    `TM_${code}_c${c}_s${s}.pdf`,
    `A_${code}_c${c}_s${s}.pdf`,
    fname.replace('.pdf', '_S.pdf'),
  ]
  for (const fn of candidates) {
    const p = path.join(PDF_CACHE, fn)
    if (!fs.existsSync(p)) continue
    const { txt } = await readPdfText(p)
    const letters = txt.match(/(?<![A-Z0-9])[A-D#](?![A-Z0-9])/g) || []
    if (letters.length >= qnum) return letters[qnum - 1]
  }
  return null
}

async function renderTarget(t) {
  const pdfPath = await findCorrectPdf(t.prefix, t.subjectKw)
  if (!pdfPath) { console.log(`  ✗ no PDF for ${t.name}`); return }
  console.log(`  PDF: ${path.basename(pdfPath)}`)

  // Find page containing the question
  const { txt, doc } = await readPdfText(pdfPath)
  const re1 = new RegExp(`\\n\\s*${t.q}[.、．]`)
  const re2 = new RegExp(`\\n\\s*${t.q}\\s*\\n`)
  let pageIdx = -1
  for (let i = 0; i < doc.countPages(); i++) {
    const pt = stripPUA(doc.loadPage(i).toStructuredText('preserve-whitespace').asText())
    if (re1.test(pt) || re2.test(pt)) { pageIdx = i; break }
  }
  if (pageIdx < 0) { console.log(`  ✗ no page for Q${t.q}`); return }

  const mupdf = await import('mupdf')
  // Render page + next page at high DPI
  for (const offset of [0, 1]) {
    const pi = pageIdx + offset
    if (pi >= doc.countPages()) break
    const page = doc.loadPage(pi)
    const pixmap = page.toPixmap(mupdf.Matrix.scale(3, 3), mupdf.ColorSpace.DeviceRGB, false, true)
    const png = Buffer.from(pixmap.asPNG())
    const outPath = path.join(OUT_DIR, `${t.name}_p${pi + 1}.png`)
    fs.writeFileSync(outPath, png)
    console.log(`  ✓ saved ${outPath} (${(png.length / 1024).toFixed(0)} KB)`)
  }

  const ans = await findAnswer(pdfPath, t.q)
  console.log(`  answer Q${t.q}: ${ans || '?'}`)
}

;(async () => {
  for (const t of TARGETS) {
    console.log(`\n=== ${t.name} ===`)
    await renderTarget(t)
  }
})().catch(e => { console.error(e); process.exit(1) })
