#!/usr/bin/env node
/**
 * 對 Tier 2 (6-15/PDF) 的 164 筆 vision_uncertain 用 pdfjs 驗證
 * 已 apply 答案但 vision_uncertain 還在的，pdfjs 若同意 → 清掉 uncertain
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const pdfjsLib = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')

const BACKEND = path.resolve(__dirname, '..')
const PDF_DIRS = [
  path.join(BACKEND, '_tmp', 'pdf-cache'),
  path.join(BACKEND, '_tmp', 'pdf-cache-100-105'),
]
const LOG = path.join(BACKEND, '_tmp', 'vision-recheck-v2-log.json')

const EXAM_FILES = {
  doctor1: 'questions.json', doctor2: 'questions-doctor2.json',
  dental1: 'questions-dental1.json', dental2: 'questions-dental2.json',
  pharma1: 'questions-pharma1.json', pharma2: 'questions-pharma2.json',
  nursing: 'questions-nursing.json', nutrition: 'questions-nutrition.json',
  medlab: 'questions-medlab.json', pt: 'questions-pt.json', ot: 'questions-ot.json',
  radiology: 'questions-radiology.json', tcm1: 'questions-tcm1.json',
  tcm2: 'questions-tcm2.json', vet: 'questions-vet.json',
  audiologist: 'questions-audiologist.json',
  'speech-therapist': 'questions-speech-therapist.json',
  rt: 'questions-rt.json',
  'social-worker': 'questions-social-worker.json',
}

function findPdf(name) {
  for (const dir of PDF_DIRS) {
    const p = path.join(dir, name)
    if (fs.existsSync(p)) return p
  }
  return null
}

async function parseAnswersPdfjs(pdfPath, targetSubject) {
  const buf = fs.readFileSync(pdfPath)
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const pages = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    const items = []
    for (const item of content.items) {
      items.push({ x: Math.round(item.transform[4]), y: Math.round(item.transform[5]), str: item.str })
    }
    items.sort((a, b) => b.y - a.y || a.x - b.x)
    pages.push(items)
  }
  let targetPage = null
  for (let i = 0; i < pages.length; i++) {
    const t = pages[i].map(it => it.str).join('').normalize('NFKC')
    if (!targetSubject || t.includes(targetSubject)) { targetPage = pages[i]; break }
  }
  if (!targetPage && pages.length === 1) targetPage = pages[0]
  if (!targetPage) return {}
  const answers = {}
  const rows = []
  let curY = null, curRow = []
  for (const item of targetPage) {
    if (curY === null || Math.abs(item.y - curY) > 3) {
      if (curRow.length) rows.push(curRow)
      curRow = [item]; curY = item.y
    } else curRow.push(item)
  }
  if (curRow.length) rows.push(curRow)
  for (let i = 0; i < rows.length; i++) {
    const nums = []
    for (const item of rows[i]) {
      const m = item.str.match(/第(\d+)題/)
      if (m) nums.push({ num: parseInt(m[1]), x: item.x })
    }
    if (nums.length >= 3 && i + 1 < rows.length) {
      const ansRow = rows[i + 1]
      const letters = ansRow.filter(r => /^[A-D]$/.test(r.str.trim())).sort((a, b) => a.x - b.x)
      nums.sort((a, b) => a.x - b.x)
      for (let j = 0; j < Math.min(nums.length, letters.length); j++) {
        answers[nums[j].num] = letters[j].str.trim()
      }
    }
  }
  if (Object.keys(answers).length >= 20) return answers
  const text = targetPage.map(r => r.str).join('').normalize('NFKC')
  const fw = /答案\s*([ＡＢＣＤ＃#]+)/g
  let m, n = 1
  while ((m = fw.exec(text)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) answers[n++] = k
      else if (ch === '＃' || ch === '#') n++
    }
  }
  return answers
}

;(async () => {
  const log = JSON.parse(fs.readFileSync(LOG, 'utf-8'))
  const mc = {}
  for (const m of log.full) mc[m.source] = (mc[m.source] || 0) + 1
  const tier2 = log.full.filter(m => mc[m.source] >= 6 && mc[m.source] <= 15)

  // group by exam + source
  const byExam = {}
  for (const m of tier2) {
    if (!byExam[m.examId]) byExam[m.examId] = {}
    if (!byExam[m.examId][m.source]) byExam[m.examId][m.source] = []
    byExam[m.examId][m.source].push(m)
  }

  let totalCleared = 0, totalKept = 0

  for (const [exam, sources] of Object.entries(byExam)) {
    const file = EXAM_FILES[exam]
    if (!file) continue
    const fp = path.join(BACKEND, file)
    if (!fs.existsSync(fp)) continue
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    const arr = data.questions || data
    const idIndex = new Map()
    for (const q of arr) idIndex.set(String(q.id), q)

    let cleared = 0, kept = 0
    for (const [pdfName, mismatches] of Object.entries(sources)) {
      const pdfPath = findPdf(pdfName)
      if (!pdfPath) { kept += mismatches.length; continue }
      let pdfjs
      try { pdfjs = await parseAnswersPdfjs(pdfPath, mismatches[0].subject) }
      catch { kept += mismatches.length; continue }
      if (Object.keys(pdfjs).length < 20) { kept += mismatches.length; continue }

      for (const m of mismatches) {
        const q = idIndex.get(String(m.qid))
        if (!q || !q.vision_uncertain) continue
        const pdfjsAnswer = pdfjs[q.number]
        if (pdfjsAnswer === q.answer) {
          // pdfjs 同意現有答案（Vision 已 apply）→ 清警告
          q.vision_uncertain = false
          cleared++
        } else {
          kept++
        }
      }
    }
    fs.writeFileSync(fp, JSON.stringify(data))
    console.log(`[${exam}] cleared=${cleared} kept=${kept}`)
    totalCleared += cleared
    totalKept += kept
  }
  console.log(`\n=== Total cleared: ${totalCleared}, kept: ${totalKept} ===`)
})().catch(e => { console.error(e); process.exit(1) })
