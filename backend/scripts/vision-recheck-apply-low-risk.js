#!/usr/bin/env node
/**
 * Apply low-risk vision-recheck-v2 mismatches.
 * 「低風險」= 該 PDF 整張只有 ≤5 個 mismatch（隔離型錯誤，非系統性 parser bug）。
 *
 * 套用：q.answer = new, q.disputed = true（標 disputed 讓使用者看見曾被修正）
 *
 * Usage:
 *   node scripts/vision-recheck-apply-low-risk.js [--dry] [--threshold 5]
 */
const fs = require('fs')
const path = require('path')

const BACKEND = path.resolve(__dirname, '..')
const LOG = path.join(BACKEND, '_tmp', 'vision-recheck-v2-log.json')
const args = process.argv.slice(2)
const dry = args.includes('--dry')
const ti = args.indexOf('--threshold')
const threshold = ti >= 0 ? parseInt(args[ti + 1]) : 5

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

const log = JSON.parse(fs.readFileSync(LOG, 'utf-8'))
const all = log.full

const mc = {}
for (const m of all) mc[m.source] = (mc[m.source] || 0) + 1

const lowRisk = all.filter(m => mc[m.source] <= threshold)
console.log(`Total mismatches: ${all.length}`)
console.log(`Low-risk (≤${threshold}/PDF): ${lowRisk.length}`)

// group by exam
const byExam = {}
for (const m of lowRisk) {
  if (!byExam[m.examId]) byExam[m.examId] = []
  byExam[m.examId].push(m)
}

let totalApplied = 0
for (const [exam, fixes] of Object.entries(byExam)) {
  const file = EXAM_FILES[exam]
  if (!file) { console.log(`[${exam}] no file mapped, skip`); continue }
  const fp = path.join(BACKEND, file)
  if (!fs.existsSync(fp)) { console.log(`[${exam}] ${file} not found, skip`); continue }
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data
  const idIndex = new Map()
  for (const q of arr) idIndex.set(String(q.id), q)

  let applied = 0, missing = 0
  for (const fix of fixes) {
    const q = idIndex.get(String(fix.qid))
    if (!q) { missing++; continue }
    if (q.answer === fix.new) continue  // already correct
    if (!dry) {
      q.answer = fix.new
      q.disputed = true
      // 加 source comment
      if (!q.answer_source) q.answer_source = `vision-recheck-v2:${fix.source}`
    }
    applied++
  }
  console.log(`[${exam}] applied=${applied} missing=${missing} (file: ${file})`)
  totalApplied += applied

  if (!dry && applied > 0) {
    fs.writeFileSync(fp, JSON.stringify(data))
  }
}

console.log(`\n=== Total applied: ${totalApplied} ${dry ? '(DRY-RUN)' : ''} ===`)
