#!/usr/bin/env node
/**
 * Fix pharma1 卷三 cross-year contamination (106-109).
 * 卷三 in those papers got the same answer key as 卷一 (藥理學與藥物化學).
 * Correct mapping: 卷三 → 藥劑學(包括生物藥劑學).
 *
 * Handles two PDF layouts:
 *   100年: 類科名稱 first, then 科目名稱
 *   106+ : 科目名稱 first, then 類科名稱 (更正清冊 format with # for special grading)
 */

const fs = require('fs')
const path = require('path')

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')

const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')

async function readPdfText(pdfPath) {
  const mupdf = await import('mupdf')
  const buf = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) {
    txt += '\n\n' + doc.loadPage(i).toStructuredText('preserve-whitespace').asText()
  }
  return stripPUA(txt)
}

function parseAnswerSection(section, qcount) {
  const ansAreaMatch = section.match(/答案\n([\s\S]+?)(?=\n\n類科名稱|\n\n備註|\n\n等級名稱|\n\n科目名稱|$)/)
  if (!ansAreaMatch) return null
  // Each "row" is 8-10 chars made of A-D or # (special). Allow # in row.
  // Match whole-line answer rows. Don't use \b because # is not a word char
  // and rows starting with # would be missed at line boundaries.
  const rows = (ansAreaMatch[1].match(/(?:^|\n)\s*([A-D#]{8,12})\s*(?=\n|$)/g) || [])
    .map(r => r.trim())
  let ans = ''
  if (qcount === 50) {
    for (let r = 0; r < 5; r++) ans += rows[r] || ''
  } else if (qcount === 80) {
    for (let r = 0; r < 6; r++) ans += rows[r] || ''
    ans += (rows[7] || '') + (rows[6] || '')
  } else if (qcount === 100) {
    for (let r = 0; r < 6; r++) ans += rows[r] || ''
    ans += (rows[7] || '') + (rows[6] || '') + (rows[8] || '') + (rows[9] || '')
  }
  if (ans.length !== qcount) return null
  return ans
}

async function findSubjectAnswers(pdfPath, subjectPattern) {
  const txt = await readPdfText(pdfPath)
  // For 106+ "更正清冊" layout: 科目名稱 first, 類科名稱 after
  // For 100年: 類科名稱 first, 科目名稱 after
  // Strategy: find each "科目名稱:..." block (always preceded or followed by 類科 nearby)
  const re = /科目名稱:([^\n]+)/g
  let m
  const subjBlocks = []
  while ((m = re.exec(txt)) !== null) {
    subjBlocks.push({ idx: m.index, subject: m[1].trim() })
  }
  for (let i = 0; i < subjBlocks.length; i++) {
    const sb = subjBlocks[i]
    if (!subjectPattern.test(sb.subject)) continue
    const start = sb.idx
    const end = i + 1 < subjBlocks.length ? subjBlocks[i+1].idx : txt.length
    const section = txt.slice(start, end)
    const qcountMatch = section.match(/題數:(\d+)題/)
    const qcount = qcountMatch ? +qcountMatch[1] : 0
    if (![50, 80, 100].includes(qcount)) continue
    const ans = parseAnswerSection(section, qcount)
    if (ans) return { subject: sb.subject, qcount, answers: ans }
  }
  return null
}

async function main() {
  const codes = ['106020','106100','107020','107100','108030','108100','109020','109100']
  const filePath = path.join(BACKEND, 'questions-pharma1.json')
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const arr = data.questions || data
  let totalChanged = 0, totalSkipped = 0
  const allDiffs = []

  for (const code of codes) {
    const pdfPath = path.join(PDF_CACHE, `A_pharma1_${code}_c305_s11.pdf`)
    if (!fs.existsSync(pdfPath)) { console.log(`  ⚠️ missing PDF for ${code}`); continue }
    // 106+ pharma1 paper ordering: 卷一=藥劑學, 卷二=藥分生藥, 卷三=藥理學與藥物化學
    const found = await findSubjectAnswers(pdfPath, /^藥理學與藥物化學/)
    if (!found) {
      console.log(`  ❌ ${code}: 藥理學與藥物化學 answers not found in PDF`)
      continue
    }
    const ans = found.answers
    let changed = 0, total = 0, skipped = 0
    const diffs = []
    for (const q of arr) {
      if (q.exam_code !== code || q.subject !== '卷三') continue
      total++
      const correct = ans[q.number - 1]
      if (!correct) continue
      if (correct === '#') { skipped++; continue }  // special grading, leave alone
      if (q.answer !== correct) {
        diffs.push({ id: q.id, n: q.number, from: q.answer, to: correct })
        q.answer = correct
        changed++
      }
    }
    console.log(`  ${code} 卷三 (藥劑學): ${changed}/${total} corrected, ${skipped} skipped (special grading)`)
    totalChanged += changed
    totalSkipped += skipped
    allDiffs.push({ code, changed, total, skipped, diffs })
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
  fs.writeFileSync(path.join(BACKEND, '_tmp', 'pharma1-cross-year-fix-log.json'), JSON.stringify(allDiffs, null, 2))
  console.log(`\n✓ Total corrected: ${totalChanged} (${totalSkipped} skipped due to special grading)`)
}

main().catch(e => { console.error(e); process.exit(1) })
