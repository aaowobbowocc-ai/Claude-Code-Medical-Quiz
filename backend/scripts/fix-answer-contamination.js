#!/usr/bin/env node
/**
 * Fix answer-key cross-contamination across multiple exam JSONs.
 *
 * Bug: scraping multi-subject answer PDFs sometimes assigned the wrong section
 * (e.g. 醫師(一) 醫學(一) answers got pasted into other unrelated subjects).
 *
 * This script:
 *   1. Parses 100030 answer PDF (already cached).
 *   2. Builds (類科, 科目) → 80/100-question answer key map.
 *   3. For each contaminated (json_file, exam_code, subject), looks up the
 *      correct subject answers and overwrites JSON.
 *   4. Writes per-file diff log.
 */

const fs = require('fs')
const path = require('path')

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')

const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')

// ---- Step 1: Parse 100030 answer PDF ----

async function parseAnswerPdf(pdfPath) {
  const mupdf = await import('mupdf')
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) {
    txt += '\n\n' + doc.loadPage(i).toStructuredText('preserve-whitespace').asText()
  }
  txt = stripPUA(txt)

  // Split into sections by 類科名稱 marker
  const markers = []
  let m
  const reMarker = /類科名稱:([^\n]+)\n+科目名稱:([^\n]+(?:\n[^\n]*)?)/g
  while ((m = reMarker.exec(txt)) !== null) {
    markers.push({ idx: m.index, type: m[1].trim(), subject: m[2].trim().replace(/\s+/g, ' ') })
  }

  const result = []
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].idx
    const end = i + 1 < markers.length ? markers[i+1].idx : txt.length
    const section = txt.slice(start, end)

    // Extract 題數
    const qcountMatch = section.match(/題數:(\d+)題/)
    const qcount = qcountMatch ? +qcountMatch[1] : 0
    if (qcount !== 80 && qcount !== 100 && qcount !== 50) continue

    // Find 答案 block — capture all 10-char A-D rows
    const ansAreaMatch = section.match(/答案\n([\s\S]+?)(?=等級名稱|$)/)
    if (!ansAreaMatch) continue
    const rows = ansAreaMatch[1].match(/\b[A-D]{8,10}\b/g) || []
    if (rows.length < Math.ceil(qcount / 10)) continue

    // Build answer string with proper ordering:
    // qcount==100: rows 0-5 = 1-60, then 71-80, 61-70, 81-90, 91-100 (PDF column-major order)
    // qcount==80:  rows 0-5 = 1-60, then 71-80, 61-70 (only)
    // qcount==50:  rows 0-4 = 1-50
    let ans = ''
    if (qcount === 50) {
      for (let r = 0; r < 5; r++) ans += rows[r] || ''
    } else if (qcount === 80) {
      for (let r = 0; r < 6; r++) ans += rows[r] || ''
      // rows[6] = 71-80, rows[7] = 61-70 → reorder
      ans += (rows[7] || '') + (rows[6] || '')
    } else if (qcount === 100) {
      for (let r = 0; r < 6; r++) ans += rows[r] || ''
      ans += (rows[7] || '') + (rows[6] || '') + (rows[8] || '') + (rows[9] || '')
    }
    if (ans.length !== qcount) {
      console.log(`  ⚠️  ${markers[i].type} :: ${markers[i].subject} got ${ans.length}/${qcount}, skipping`)
      continue
    }
    result.push({ type: markers[i].type, subject: markers[i].subject, qcount, answers: ans })
  }
  return result
}

// ---- Step 2: Mapping (json_subject → pdf type+subject) ----
// Only direct/safe mappings. Unsafe ones (medlab, pharma) handled later.

const FIXES_100030 = [
  // doctor2
  { file: 'questions-doctor2.json', subject: '醫學(三)', pdfType: '醫師(二)', pdfSubjPrefix: '醫學(三)' },
  { file: 'questions-doctor2.json', subject: '醫學(四)', pdfType: '醫師(二)', pdfSubjPrefix: '醫學(四)' },
  { file: 'questions-doctor2.json', subject: '醫學(五)', pdfType: '醫師(二)', pdfSubjPrefix: '醫學(五)' },
  { file: 'questions-doctor2.json', subject: '醫學(六)', pdfType: '醫師(二)', pdfSubjPrefix: '醫學(六)' },
  // pt
  { file: 'questions-pt.json', subject: '物理治療基礎學', pdfType: '物理治療師', pdfSubjPrefix: '物理治療基礎學' },
  { file: 'questions-pt.json', subject: '心肺疾病與小兒疾病物理治療學', pdfType: '物理治療師', pdfSubjPrefix: '心肺疾病與小兒疾病物理治療學' },
  // tcm1
  { file: 'questions-tcm1.json', subject: '中醫基礎醫學(一)', pdfType: '中醫師', pdfSubjPrefix: '中醫基礎醫學(一)' },
  { file: 'questions-tcm1.json', subject: '中醫基礎醫學(二)', pdfType: '中醫師', pdfSubjPrefix: '中醫基礎醫學(二)' },
  // tcm2
  { file: 'questions-tcm2.json', subject: '中醫臨床醫學(一)', pdfType: '中醫師', pdfSubjPrefix: '中醫臨床醫學(一)' },
  { file: 'questions-tcm2.json', subject: '中醫臨床醫學(三)', pdfType: '中醫師', pdfSubjPrefix: '中醫臨床醫學(三)' },
  { file: 'questions-tcm2.json', subject: '中醫臨床醫學(四)', pdfType: '中醫師', pdfSubjPrefix: '中醫臨床醫學(四)' },
  // medlab — direct or close name match
  { file: 'questions-medlab.json', subject: '微生物學與臨床微生物學', pdfType: '醫事檢驗師', pdfSubjPrefix: '微生物學及臨床微生物學' },
  // medlab JSON uses later-year naming "醫學分子檢驗學與臨床鏡檢學", but 100年 content is 臨床鏡檢學
  { file: 'questions-medlab.json', subject: '醫學分子檢驗學與臨床鏡檢學', pdfType: '醫事檢驗師', pdfSubjPrefix: '臨床鏡檢學(包括寄生蟲學)' },
  // pharma2 — these subjects in JSON map to 藥師 PDF subjects by name
  { file: 'questions-pharma2.json', subject: '調劑與臨床', pdfType: '藥師', pdfSubjPrefix: '調劑學與臨床藥學' },
  { file: 'questions-pharma2.json', subject: '法規', pdfType: '藥師', pdfSubjPrefix: '藥事行政與法規' },
  // pharma1 — 卷一=藥理&化學 (already correct), 卷二=藥分&生藥, 卷三=藥劑學
  { file: 'questions-pharma1.json', subject: '卷二', pdfType: '藥師', pdfSubjPrefix: '藥物分析與生藥學' },
  { file: 'questions-pharma1.json', subject: '卷三', pdfType: '藥師', pdfSubjPrefix: '藥劑學(包括生物藥劑學)' },
]

// ---- Step 3: Apply fixes ----

async function main() {
  console.log('Parsing 100030 answer PDF...')
  const pdfPath = path.join(PDF_CACHE, 'A_nursing_100030_c101_s0101.pdf')
  const sections = await parseAnswerPdf(pdfPath)
  console.log(`  parsed ${sections.length} subject answer keys\n`)

  const lookupKey = (type, prefix) => {
    const found = sections.find(s => s.type === type && s.subject.startsWith(prefix))
    return found ? found.answers : null
  }

  const allDiffs = []
  for (const fix of FIXES_100030) {
    const filePath = path.join(BACKEND, fix.file)
    if (!fs.existsSync(filePath)) { console.log(`  ⚠️ missing ${fix.file}`); continue }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const arr = data.questions || data

    const ans = lookupKey(fix.pdfType, fix.pdfSubjPrefix)
    if (!ans) {
      console.log(`  ❌ no PDF answer for ${fix.pdfType}::${fix.pdfSubjPrefix}`)
      continue
    }

    let changed = 0, total = 0
    const diffs = []
    for (const q of arr) {
      if (q.exam_code !== '100030' || q.subject !== fix.subject) continue
      total++
      const correct = ans[q.number - 1]
      if (!correct) continue
      if (q.answer !== correct) {
        diffs.push({ id: q.id, n: q.number, from: q.answer, to: correct })
        q.answer = correct
        changed++
      }
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
    console.log(`  ✓ ${fix.file} 100030 ${fix.subject}: ${changed}/${total} corrected`)
    allDiffs.push({ ...fix, total, changed, diffs })
  }

  fs.writeFileSync(path.join(BACKEND, '_tmp', 'answer-fix-log.json'), JSON.stringify(allDiffs, null, 2))
  console.log(`\nLog saved to _tmp/answer-fix-log.json`)
  console.log(`Total subjects fixed: ${allDiffs.length}`)
  console.log(`Total questions corrected: ${allDiffs.reduce((s, d) => s + d.changed, 0)}`)
}

main().catch(e => { console.error(e); process.exit(1) })
