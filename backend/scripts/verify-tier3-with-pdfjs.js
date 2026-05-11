#!/usr/bin/env node
/**
 * 對 Tier 3 高風險 mismatches 做 pdfjsLib 位置解析交叉驗證。
 *
 * 策略：
 *   1. 對每個 unique source PDF（vision-recheck v2 報過 ≥16 mismatches 的）
 *   2. 用 pdfjsLib 位置基礎重新 parse 答案
 *   3. 比對 stored / vision-OCR / pdfjsLib 三方：
 *      - vision === pdfjs ≠ stored → 高信心，apply（兩個獨立方法都同意 vision 對）
 *      - vision ≠ pdfjs → 低信心，留 vision_uncertain 不改
 *   4. apply 後自動清掉 vision_uncertain
 *
 * 完全免費（純 pdfjs 本地解析，不打 Vertex）。
 *
 * Usage:
 *   node scripts/verify-tier3-with-pdfjs.js [--dry] [--exam X]
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
const OCR_CACHE = path.join(BACKEND, '_tmp', 'vision-ocr-cache.json')
const APPLY_LOG = path.join(BACKEND, '_tmp', 'pdfjs-verify-log.json')

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const examFilter = args.indexOf('--exam') >= 0 ? args[args.indexOf('--exam') + 1] : null

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

// pdfjs 位置基礎答案解析
// 處理 3 種格式：
//   1. 表格型：題號 row + 答案 row（位置 X 對齊）
//   2. 全形連續：答案ＡＢＣＤＡＢ...
//   3. 半形連續：答案ABCDAB...
async function parseAnswersPdfjs(pdfPath, targetSubject) {
  const buf = fs.readFileSync(pdfPath)
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  // 收集每頁的位置資料
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

  // 找包含 targetSubject 的頁
  let targetPage = null
  let allText = ''
  for (let i = 0; i < pages.length; i++) {
    const t = pages[i].map(it => it.str).join('').normalize('NFKC')
    allText += t + '\n'
    if (!targetSubject || t.includes(targetSubject)) {
      targetPage = pages[i]
      break
    }
  }
  if (!targetPage && pages.length === 1) targetPage = pages[0]
  if (!targetPage) return {}

  const answers = {}

  // Method 1: 表格型「第N題」+ 字母
  const rows = []
  let curY = null, curRow = []
  for (const item of targetPage) {
    if (curY === null || Math.abs(item.y - curY) > 3) {
      if (curRow.length) rows.push(curRow)
      curRow = [item]; curY = item.y
    } else { curRow.push(item) }
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

  // Method 2: 全形連續
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
  if (Object.keys(answers).length >= 20) return answers

  // Method 3: 半形連續
  const hw = /答案\s*([A-D#]{10,})/gi
  n = 1
  while ((m = hw.exec(text)) !== null) {
    for (const ch of m[1]) {
      if (/[A-D]/i.test(ch)) answers[n] = ch.toUpperCase()
      n++
    }
  }
  return answers
}

;(async () => {
  const log = JSON.parse(fs.readFileSync(LOG, 'utf-8'))
  const ocrCache = JSON.parse(fs.readFileSync(OCR_CACHE, 'utf-8'))

  // 統計每張 PDF 的 mismatch 數
  const mc = {}
  for (const m of log.full) mc[m.source] = (mc[m.source] || 0) + 1

  // Tier 3: ≥16/PDF
  const tier3 = log.full.filter(m => mc[m.source] >= 16)
  if (examFilter) {
    const before = tier3.length
    const filtered = tier3.filter(m => m.examId === examFilter)
    console.log(`Filter --exam ${examFilter}: ${before} → ${filtered.length}`)
    tier3.length = 0; tier3.push(...filtered)
  }
  console.log(`Tier 3 mismatches: ${tier3.length}`)

  // group by source PDF
  const bySource = {}
  for (const m of tier3) {
    if (!bySource[m.source]) bySource[m.source] = []
    bySource[m.source].push(m)
  }
  console.log(`Unique source PDFs: ${Object.keys(bySource).length}\n`)

  // 載入 question files
  const examData = {}
  const examIdIndex = {}
  for (const [exam, file] of Object.entries(EXAM_FILES)) {
    const fp = path.join(BACKEND, file)
    if (!fs.existsSync(fp)) continue
    examData[exam] = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    examIdIndex[exam] = new Map()
    const arr = examData[exam].questions || examData[exam]
    for (const q of arr) examIdIndex[exam].set(String(q.id), q)
  }

  const applyLog = []
  let totalConfirmed = 0  // pdfjs + vision 都同意
  let totalDisagree = 0   // pdfjs + vision 不同意
  let totalSkipped = 0
  let pdfIdx = 0
  for (const [pdfName, mismatches] of Object.entries(bySource)) {
    pdfIdx++
    const pdfPath = findPdf(pdfName)
    if (!pdfPath) { totalSkipped += mismatches.length; continue }

    const exam = mismatches[0].examId
    const subject = mismatches[0].subject

    // pdfjs parse 一次
    let pdfjsAns
    try {
      pdfjsAns = await parseAnswersPdfjs(pdfPath, subject)
    } catch (e) {
      console.log(`  [${pdfIdx}] ${pdfName} pdfjs failed: ${e.message}`)
      totalSkipped += mismatches.length
      continue
    }

    if (Object.keys(pdfjsAns).length < 20) {
      console.log(`  [${pdfIdx}] ${pdfName} pdfjs got <20 answers, skip`)
      totalSkipped += mismatches.length
      continue
    }

    let confirmed = 0, disagree = 0
    for (const m of mismatches) {
      const q = examIdIndex[exam]?.get(String(m.qid))
      if (!q) { disagree++; continue }
      const pdfjsAnswer = pdfjsAns[q.number]
      const visionAnswer = m.new
      if (!pdfjsAnswer || !/^[ABCD]$/.test(pdfjsAnswer)) { disagree++; continue }

      if (pdfjsAnswer === visionAnswer && pdfjsAnswer !== q.answer) {
        // 兩個獨立方法都認同 → 高信心
        applyLog.push({
          qid: q.id, exam, subject: q.subject, num: q.number,
          old: q.answer, new: pdfjsAnswer, source: pdfName,
          methods: ['vision', 'pdfjs'],
        })
        if (!dry) {
          q.answer = pdfjsAnswer
          q.vision_uncertain = false  // 清掉警告
          q.disputed = true            // 標 disputed（系統修正）
        }
        confirmed++
        totalConfirmed++
      } else {
        disagree++
        totalDisagree++
      }
    }
    if (pdfIdx <= 10 || pdfIdx % 10 === 0) {
      console.log(`  [${pdfIdx}/${Object.keys(bySource).length}] ${pdfName} | confirmed ${confirmed} disagree ${disagree}`)
    }
  }

  console.log(`\n=== Summary ===`)
  console.log(`Confirmed (vision+pdfjs agree): ${totalConfirmed} ← apply`)
  console.log(`Disagree (uncertain): ${totalDisagree} ← keep`)
  console.log(`Skipped (no PDF / pdfjs fail): ${totalSkipped}`)

  // write log
  fs.writeFileSync(APPLY_LOG, JSON.stringify({
    timestamp: new Date().toISOString(),
    dry,
    confirmed: totalConfirmed,
    disagree: totalDisagree,
    skipped: totalSkipped,
    samples: applyLog.slice(0, 50),
    full: applyLog,
  }, null, 2))
  console.log(`Log: ${path.relative(BACKEND, APPLY_LOG)}`)

  if (!dry) {
    for (const exam of Object.keys(examData)) {
      const file = EXAM_FILES[exam]
      const fp = path.join(BACKEND, file)
      fs.writeFileSync(fp, JSON.stringify(examData[exam]))
    }
    console.log(`Applied ${totalConfirmed} changes across ${Object.keys(EXAM_FILES).length} files`)
  } else {
    console.log(`(DRY-RUN — 加 --apply 為實際變更，但目前預設就是非 dry，請加 --dry 預演）`)
  }
})().catch(e => { console.error(e); process.exit(1) })
