#!/usr/bin/env node
/**
 * disputed 題檢驗 — 找 disputed=true 但 stored answer 跟 Vision OCR 不一致的。
 *
 * 邏輯：之前的 scraper bug 可能標 disputed 但沒套用考選部的更正答案。
 * 用 vision-ocr-cache 已有的 OCR 結果（不再額外呼叫 Vertex）。
 *
 * 完全免費（0 Vertex calls，純讀 cache 比對）。
 */
const fs = require('fs')
const path = require('path')

const BACKEND = path.resolve(__dirname, '..')
const OCR_CACHE = path.join(BACKEND, '_tmp', 'vision-ocr-cache.json')
const META_CACHE = path.join(BACKEND, '_tmp', 'pdf-metadata-cache.json')
const LOG = path.join(BACKEND, '_tmp', 'disputed-verify-log.json')

const args = process.argv.slice(2)
const dry = args.includes('--dry')

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

const norm = s => (s || '').normalize('NFKC').replace(/\s/g, '')

const ocrCache = JSON.parse(fs.readFileSync(OCR_CACHE, 'utf-8'))
const metaCache = JSON.parse(fs.readFileSync(META_CACHE, 'utf-8'))

// 建 (examCode, subject) → OCR ans map
// 用 metaCache 找到 PDF + section subject，再從 OCR cache 拿答案
const subjectAnswers = new Map()  // key = examCode|subject_normalized → { qnum: answer }
for (const [pdfName, meta] of Object.entries(metaCache)) {
  if (!meta.sections || !meta.exam_code) continue
  const ocrResult = ocrCache[pdfName]
  if (!ocrResult) continue
  for (const sec of meta.sections) {
    if (sec.multi) continue
    if (!sec.subject) continue
    const subjN = norm(sec.subject)
    // OCR result 可能是 { subjectName: {qnum: ans} } 或 { _default: {...} } 或 page-specific
    let ansMap = ocrResult[sec.subject] || ocrResult[subjN]
    if (!ansMap) {
      // 嘗試找其他 entries
      for (const [s, m] of Object.entries(ocrResult)) {
        if (norm(s) === subjN || norm(s).includes(subjN)) { ansMap = m; break }
      }
    }
    if (!ansMap) continue
    const key = `${meta.exam_code}|${subjN}`
    if (!subjectAnswers.has(key)) subjectAnswers.set(key, ansMap)
  }
}
console.log('OCR-indexed (exam_code, subject) pairs:', subjectAnswers.size)

let totalDisputed = 0, totalWithOcr = 0, totalShouldFix = 0
const allFixes = []

for (const [exam, file] of Object.entries(EXAM_FILES)) {
  const fp = path.join(BACKEND, file)
  if (!fs.existsSync(fp)) continue
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data
  const disputed = arr.filter(q => q.disputed === true && !q.vision_uncertain)
  totalDisputed += disputed.length
  let fixCount = 0
  for (const q of disputed) {
    if (!q.exam_code || !q.subject || !q.number) continue
    if (q.answer === '送分') continue
    if (/[#＃,]/.test(q.answer || '')) continue  // 多答案 disputed，跳過
    const subjN = norm(q.subject)
    const ansMap = subjectAnswers.get(`${q.exam_code}|${subjN}`)
    if (!ansMap) continue
    const ocrAns = ansMap[String(q.number)] || ansMap[q.number]
    if (!ocrAns || !/^[ABCD]$/.test(ocrAns)) continue
    totalWithOcr++
    if (ocrAns !== q.answer) {
      totalShouldFix++
      allFixes.push({
        exam, qid: q.id, year: q.roc_year, session: q.session,
        subject: q.subject, num: q.number, old: q.answer, new: ocrAns,
      })
      if (!dry) {
        q.answer = ocrAns
        // disputed 維持 true（這題本來就有更正紀錄）
      }
      fixCount++
    }
  }
  if (!dry && fixCount > 0) fs.writeFileSync(fp, JSON.stringify(data))
  console.log(`[${exam.padEnd(20)}] disputed=${disputed.length} should-fix=${fixCount}`)
}

fs.writeFileSync(LOG, JSON.stringify({
  timestamp: new Date().toISOString(),
  dry, totalDisputed, totalWithOcr, totalShouldFix,
  samples: allFixes.slice(0, 50), full: allFixes,
}, null, 2))

console.log(`\n=== Total disputed: ${totalDisputed} | OCR available: ${totalWithOcr} | should-fix: ${totalShouldFix} ===`)
console.log(`Log: ${path.relative(BACKEND, LOG)}`)
