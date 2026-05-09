#!/usr/bin/env node
/**
 * 掃描全站「題幹+選項都沒提到圖卻被加 image_url 的題」(隱性假陽性)。
 * 不修改 JSON，只輸出清單給人類審核。
 *
 * Usage:
 *   node scripts/scan-image-false-positives.js [--exam X]
 *   node scripts/scan-image-false-positives.js --apply  # 確認後直接清掉
 */
const fs = require('fs')
const path = require('path')
const { atomicWriteJson } = require('./lib/atomic-write')

const BACKEND = path.resolve(__dirname, '..')
const args = process.argv.slice(2)
const examFilter = args[args.indexOf('--exam') + 1]
const apply = args.includes('--apply')

// 題幹/選項裡只要含這些字之一，就視為「有圖題」(true positive)
const IMAGE_KEYWORDS = [
  '圖', '附件', '示意', '附表', '見上', '見下',
  '波形', '結構式', '化學式', 'X 光', 'X光', 'X-ray', 'CT', 'MRI',
  'phonetic', 'spectrogram',
  // 選項是圖時典型 placeholder
  '見附圖', '見上圖', '見下圖', '本題含圖',
]

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
  police: 'questions-police.json',
  police4: 'questions-police4.json',
  customs: 'questions-customs.json',
  judicial: 'questions-judicial.json',
  'civil-senior': 'questions-civil-senior.json',
  lawyer1: 'questions-lawyer1.json',
  'social-worker': 'questions-social-worker.json',
}

function scanQ(q) {
  // Has image_url that looks like patrol/full crop (not legit pre-existing /question-images/foo)
  if (!q.image_url) return null
  if (!/_(?:patrol|full)\.webp$/.test(q.image_url)) return null

  const text = (q.question || '') + ' ' + Object.values(q.options || {}).join(' ')
  for (const kw of IMAGE_KEYWORDS) {
    if (text.includes(kw)) return null  // is true positive
  }
  return {
    id: q.id, num: q.number, exam_code: q.exam_code, session: q.session,
    subject: q.subject, image_url: q.image_url,
    excerpt: (q.question || '').slice(0, 60),
  }
}

const report = { totalScanned: 0, totalFP: 0, byExam: {} }

const exams = examFilter ? [examFilter] : Object.keys(EXAM_FILES)
for (const exam of exams) {
  if (exam === 'pt' || exam === 'ot') continue
  const file = EXAM_FILES[exam]
  const fp = path.join(BACKEND, file)
  if (!fs.existsSync(fp)) continue
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data
  report.totalScanned += arr.length
  const fpHere = []
  for (const q of arr) {
    const f = scanQ(q)
    if (f) {
      fpHere.push(f)
      if (apply) { delete q.image_url; if (q.incomplete === 'image_options') delete q.incomplete }
    }
  }
  if (fpHere.length) {
    report.byExam[exam] = { count: fpHere.length, samples: fpHere }
    report.totalFP += fpHere.length
    if (apply) atomicWriteJson(fp, data)
  }
}

const out = path.join(BACKEND, '_tmp', 'image-false-positives.json')
fs.writeFileSync(out, JSON.stringify(report, null, 2))

console.log(`掃描 ${report.totalScanned} 題，找到 ${report.totalFP} 題隱性假陽性 ${apply ? '(已清除 image_url)' : '(僅報告，未修)'}：`)
for (const [exam, info] of Object.entries(report.byExam).sort((a,b) => b[1].count - a[1].count)) {
  console.log(`  ${exam.padEnd(20)} ${info.count} 題`)
}
console.log(``)
console.log(`報告：${out}`)
if (!apply) console.log(`若確認要清，重跑: node scripts/scan-image-false-positives.js --apply`)
