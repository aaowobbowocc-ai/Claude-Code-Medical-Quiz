#!/usr/bin/env node
/**
 * 修兩題 cross_page：render 兩頁合併成一張長 webp。
 * radiology 3106 (111100 Q77), vet 3839 (109100 Q79)
 */
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')
const IMG_OUT = path.join(BACKEND, '..', 'frontend', 'public', 'question-images')
const SCALE = 3

const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')
const cleanText = s => (s || '').normalize('NFKC').replace(/[\s,，。、．.;；:：?？!！()（）「」『』《》<>《》【】\[\]]/g, '')

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }

function findCandidatePdfs(exam, exam_code) {
  return fs.readdirSync(PDF_CACHE).filter(f =>
    f.endsWith('.pdf') &&
    !/^(TM|TS|M|S|A|TA)_/.test(f) &&
    (f.startsWith(`${exam}_${exam_code}_`) || new RegExp(`(?:^|_)Q_${exam_code}_c\\d+_s`).test(f))
  )
}

async function findPageWithQuestion(pdfPath, qnum, dbQHint) {
  const mupdf = await getMupdf()
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n = doc.countPages()
  const patterns = [
    new RegExp(`(?:^|\\n)\\s*${qnum}\\s*[.、．]`),
    new RegExp(`(?:^|\\n)\\s*${qnum}\\s*\\n`),
    new RegExp(`第\\s*${qnum}\\s*題`),
  ]
  const cleanHint = cleanText(dbQHint).slice(0, 10)
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i)
    const text = stripPUA(page.toStructuredText('preserve-whitespace').asText())
    for (const re of patterns) {
      if (re.test(text)) {
        if (cleanHint.length >= 6 && !cleanText(text).includes(cleanHint.slice(0, 6))) continue
        return { doc, mupdf, idx: i, totalPages: n }
      }
    }
  }
  return null
}

async function renderPagePng(doc, mupdf, idx) {
  const page = doc.loadPage(idx)
  const px = page.toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceRGB, false, true)
  return Buffer.from(px.asPNG())
}

async function combineVertical(pngBuffers, outPath) {
  const metas = await Promise.all(pngBuffers.map(b => sharp(b).metadata()))
  const maxW = Math.max(...metas.map(m => m.width))
  const totalH = metas.reduce((a, m) => a + m.height, 0)
  // Composite buffers
  const composites = []
  let yOffset = 0
  for (let i = 0; i < pngBuffers.length; i++) {
    composites.push({ input: pngBuffers[i], top: yOffset, left: Math.floor((maxW - metas[i].width) / 2) })
    yOffset += metas[i].height
  }
  await sharp({
    create: { width: maxW, height: totalH, channels: 3, background: { r: 255, g: 255, b: 255 } }
  })
    .composite(composites)
    .webp({ quality: 80 })
    .toFile(outPath)
}

const targets = [
  { exam: 'radiology', file: 'questions-radiology.json', id: 3106, ec: '111100', n: 77 },
  { exam: 'vet',       file: 'questions-vet.json',       id: 3839, ec: '109100', n: 79 },
]

;(async () => {
  for (const t of targets) {
    const fp = path.join(BACKEND, t.file)
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
    const arr = data.questions || data
    const q = arr.find(x => x.id === t.id)
    if (!q) { console.log(t.exam, t.id, 'not found'); continue }

    const candidates = findCandidatePdfs(t.exam, t.ec)
    let info = null
    for (const f of candidates) {
      try {
        info = await findPageWithQuestion(path.join(PDF_CACHE, f), t.n, q.question)
        if (info) { info.pdfFile = f; break }
      } catch {}
    }
    if (!info) { console.log(t.exam, t.id, 'PDF page not found'); continue }
    if (info.idx + 1 >= info.totalPages) { console.log(t.exam, t.id, 'no next page'); continue }

    const png1 = await renderPagePng(info.doc, info.mupdf, info.idx)
    const png2 = await renderPagePng(info.doc, info.mupdf, info.idx + 1)

    const outName = `${t.exam}_${t.ec}_q${t.n}_full.webp`
    const outPath = path.join(IMG_OUT, outName)
    await combineVertical([png1, png2], outPath)
    const stat = fs.statSync(outPath)
    console.log(`✓ ${t.exam} ${t.id}: combined 2 pages → ${outName} (${(stat.size / 1024).toFixed(0)} KB)`)
    // image_url is already set, just confirm
    q.image_url = '/question-images/' + outName
    fs.writeFileSync(fp, JSON.stringify(data, null, 2))
  }
  console.log('\nDONE')
})().catch(e => { console.error(e); process.exit(1) })
