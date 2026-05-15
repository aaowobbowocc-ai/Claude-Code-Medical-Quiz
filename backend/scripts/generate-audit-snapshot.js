#!/usr/bin/env node
// Generates audit summary JSON for admin dashboard.
// Output: frontend/public/audit-snapshot.json
// Run via: node scripts/generate-audit-snapshot.js
const fs = require('fs')
const path = require('path')

const BACKEND = path.resolve(__dirname, '..')
const OUT = path.resolve(BACKEND, '..', 'frontend', 'public', 'audit-snapshot.json')

const QFILES = fs.readdirSync(BACKEND).filter(f => /^questions(-[\w-]+)?\.json$/.test(f))
const SHARED_DIR = path.join(BACKEND, 'shared-banks')
const sharedFiles = fs.existsSync(SHARED_DIR)
  ? fs.readdirSync(SHARED_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'))
  : []

function isAnswerValid(ans) {
  if (!ans) return false
  if (ans === '送分') return true
  return /^[A-D](,[A-D])*$/.test(ans) || /^[A-E]$/.test(ans)
}

function checkPollution(q) {
  if (!q.question || !q.options) return false
  if (q.subject && /英文|英語/.test(q.subject)) return false
  const m = q.question.match(/[?？]\s*([\s\S]+)$/)
  if (!m) return false
  const trailing = m[1].trim()
  if (trailing.length < 20) return false
  const optA = (q.options.A || '').slice(0, 30).replace(/\s+/g, '')
  const trH = trailing.slice(0, 30).replace(/\s+/g, '')
  if (optA.length < 10 || trH.length < 10) return false
  return optA.slice(0, 10) === trH.slice(0, 10) || trH.includes(optA.slice(0, 10))
}

function auditFile(filePath, displayName) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  const arr = data.questions || data
  const idCount = {}
  for (const q of arr) { if (q.id) idCount[q.id] = (idCount[q.id] || 0) + 1 }
  const result = {
    file: displayName,
    total: arr.length,
    incomplete: 0,
    incompleteByType: {},
    disputed: 0,
    visionUncertain: 0,
    issues: {
      missing_answer: 0, invalid_answer: 0, empty_options: 0, short_question: 0,
      duplicate_id: 0, pollution: 0, answer_not_in_options: 0, options_lt_4: 0,
      option_too_long: 0, multi_answer_disputed_missing: 0,
    },
    yearCoverage: {}, sessionCoverage: {}, subjectCoverage: {},
  }
  for (const q of arr) {
    // Metadata stats
    if (q.incomplete) {
      result.incomplete++
      const type = String(q.incomplete)
      result.incompleteByType[type] = (result.incompleteByType[type] || 0) + 1
    }
    if (q.disputed) result.disputed++
    if (q.vision_uncertain) result.visionUncertain++
    if (q.roc_year) result.yearCoverage[q.roc_year] = (result.yearCoverage[q.roc_year] || 0) + 1
    if (q.session) result.sessionCoverage[q.session] = (result.sessionCoverage[q.session] || 0) + 1
    if (q.subject) result.subjectCoverage[q.subject] = (result.subjectCoverage[q.subject] || 0) + 1

    // Issue checks (skip incomplete for most checks, since they're already excluded from quiz pool)
    const isIncomplete = !!q.incomplete
    const isTF = q.type === 'tf'
    if (!q.answer || String(q.answer).trim() === '') {
      if (!isIncomplete) result.issues.missing_answer++
      continue
    }
    if (!isAnswerValid(q.answer)) result.issues.invalid_answer++
    if (!q.options || typeof q.options !== 'object') {
      if (!isIncomplete) result.issues.empty_options++
      continue
    }
    if (!isIncomplete) {
      const optKeys = Object.keys(q.options)
      if (optKeys.length < 4 && !isTF) result.issues.options_lt_4++
      for (const k of optKeys) {
        if (!q.options[k] || String(q.options[k]).trim() === '') {
          if (!isTF || (k !== 'C' && k !== 'D')) result.issues.empty_options++
        }
        if (q.options[k] && String(q.options[k]).length > 400) result.issues.option_too_long++
      }
      if (/^[A-D]$/.test(q.answer) && !q.options[q.answer]) result.issues.answer_not_in_options++
      if (q.question && q.question.length < 5 && !isTF) result.issues.short_question++
      if (checkPollution(q)) result.issues.pollution++
    }
    if (/^[A-D],[A-D]/.test(q.answer) && !q.disputed) result.issues.multi_answer_disputed_missing++
    if (q.id && idCount[q.id] > 1) result.issues.duplicate_id++
  }
  return result
}

console.log('Generating audit snapshot...')
const examFiles = QFILES.map(f => ({
  filePath: path.join(BACKEND, f),
  displayName: f.replace(/^questions-?/, '').replace(/\.json$/, '') || 'doctor1',
}))
const sharedFileList = sharedFiles.map(f => ({
  filePath: path.join(SHARED_DIR, f),
  displayName: 'shared/' + f.replace(/\.json$/, ''),
}))

const exams = examFiles.map(e => auditFile(e.filePath, e.displayName))
const shared = sharedFileList.map(e => auditFile(e.filePath, e.displayName))

// Aggregate totals
const total = { exams: 0, shared: 0, totalQ: 0, incomplete: 0, disputed: 0, visionUncertain: 0, issues: {} }
for (const e of exams) {
  total.exams++
  total.totalQ += e.total
  total.incomplete += e.incomplete
  total.disputed += e.disputed
  total.visionUncertain += e.visionUncertain
  for (const [k, v] of Object.entries(e.issues)) total.issues[k] = (total.issues[k] || 0) + v
}
for (const s of shared) {
  total.shared++
  total.totalQ += s.total
  total.incomplete += s.incomplete
  for (const [k, v] of Object.entries(s.issues)) total.issues[k] = (total.issues[k] || 0) + v
}

const snapshot = {
  generatedAt: new Date().toISOString(),
  total,
  exams,
  shared,
}

fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2))
const stats = fs.statSync(OUT)
console.log(`✓ Written ${OUT} (${(stats.size / 1024).toFixed(1)} KB)`)
console.log(`  ${total.exams} exams + ${total.shared} shared banks | ${total.totalQ.toLocaleString()} questions`)
console.log(`  incomplete: ${total.incomplete} | disputed: ${total.disputed} | vision_uncertain: ${total.visionUncertain}`)
console.log(`  real bugs:`, JSON.stringify(total.issues))
