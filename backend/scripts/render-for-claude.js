#!/usr/bin/env node
/** 把現存 incomplete 題目的 PDF 頁渲染成 PNG，供 Claude 直接 Read。 */
const fs = require('fs')
const path = require('path')

const BACKEND = path.resolve(__dirname, '..')
const OUT_DIR = path.join(BACKEND, '_tmp', 'incomplete-for-claude')
const PDF_CACHE_DIRS = [
  path.join(BACKEND, '_tmp', 'pdf-cache'),
  path.join(BACKEND, '_tmp', 'pdf-cache-100-105'),
]
fs.mkdirSync(OUT_DIR, { recursive: true })

const examConfigDir = path.join(BACKEND, 'exam-configs')

async function main() {
  const mupdf = await import('mupdf')
  const targets = []
  for (const f of fs.readdirSync(examConfigDir).filter(x => x.endsWith('.json'))) {
    const c = JSON.parse(fs.readFileSync(path.join(examConfigDir, f)))
    if (!c.questionsFile) continue
    const fp = path.join(BACKEND, c.questionsFile)
    if (!fs.existsSync(fp)) continue
    const data = JSON.parse(fs.readFileSync(fp))
    for (const q of (data.questions || data)) {
      if (q.incomplete) targets.push({ ...q, examId: c.id, examName: c.name })
    }
  }
  console.log(`Rendering ${targets.length} questions...`)
  const manifest = []
  for (const q of targets) {
    // Find PDF
    let pdfPath = null
    for (const dir of PDF_CACHE_DIRS) {
      if (!fs.existsSync(dir)) continue
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.pdf')) continue
        if (f.startsWith(`Q_${q.exam_code}_c${q.class_code}_`)) { pdfPath = path.join(dir, f); break }
      }
      if (pdfPath) break
    }
    if (!pdfPath) {
      // Looser: any Q_<exam_code>_
      for (const dir of PDF_CACHE_DIRS) {
        if (!fs.existsSync(dir)) continue
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith(`Q_${q.exam_code}_`) && f.endsWith('.pdf')) { pdfPath = path.join(dir, f); break }
        }
        if (pdfPath) break
      }
    }
    if (!pdfPath) {
      console.log(`✗ ${q.examId} ${q.exam_code} Q${q.number}: no PDF`)
      continue
    }
    // Render — find the page first by text match. We may have to scan multiple PDFs
    // for the right one (s code unknown). For now, scan all candidates with same exam_code.
    const candidates = []
    for (const dir of PDF_CACHE_DIRS) {
      if (!fs.existsSync(dir)) continue
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.pdf') && f.startsWith(`Q_${q.exam_code}_`)) candidates.push(path.join(dir, f))
      }
    }
    let foundPage = null
    let foundFile = null
    for (const cand of candidates) {
      try {
        const buf = fs.readFileSync(cand)
        const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
        const n = doc.countPages()
        for (let i = 0; i < n; i++) {
          const p = doc.loadPage(i)
          const text = p.toStructuredText('preserve-whitespace').asText()
          // Match question number on this page + subject mention
          const numRe = new RegExp(`(?:^|\\n)\\s*${q.number}[.、．\\s]`)
          if (numRe.test(text) && text.includes(q.subject.slice(0, 4))) {
            foundPage = p
            foundFile = path.basename(cand)
            // Render at 200 DPI
            const matrix = mupdf.Matrix.scale(2.78, 2.78)
            const pixmap = p.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true)
            const png = Buffer.from(pixmap.asPNG())
            const out = `${q.examId}_${q.exam_code}_q${q.number}.png`
            fs.writeFileSync(path.join(OUT_DIR, out), png)
            manifest.push({
              examId: q.examId, examName: q.examName,
              roc_year: q.roc_year, session: q.session,
              exam_code: q.exam_code, subject: q.subject, number: q.number,
              gap_reason: q.gap_reason || (typeof q.incomplete === 'string' ? q.incomplete : 'incomplete'),
              question_id: q.id,
              png: out, pdf: foundFile, page_idx: i,
              current_question: q.question,
              current_options: q.options,
            })
            break
          }
        }
        if (foundPage) break
      } catch (e) {}
    }
    if (foundFile) console.log(`✓ ${q.examId}_${q.exam_code}_q${q.number}.png (from ${foundFile})`)
    else console.log(`✗ ${q.examId} ${q.exam_code} Q${q.number}: page not found in ${candidates.length} candidates`)
  }
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`\n✓ ${manifest.length}/${targets.length} rendered → ${OUT_DIR}`)
}

main().catch(e => { console.error(e); process.exit(1) })
