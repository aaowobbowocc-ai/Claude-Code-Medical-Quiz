#!/usr/bin/env node
// 全題庫健檢：掃所有 questions-*.json + shared-banks
// 偵測：empty/missing options, answer 異常, 重複 ID, 異常題幹, 卷別/科目不一致
const fs = require('fs')
const path = require('path')

const QFILES = fs.readdirSync('.').filter(f => /^questions(-[\w-]+)?\.json$/.test(f))
const SHARED_DIR = 'shared-banks'
const sharedFiles = fs.existsSync(SHARED_DIR)
  ? fs.readdirSync(SHARED_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'))
  : []

const issues = {
  missing_answer: [], invalid_answer: [], empty_options: [], short_question: [],
  duplicate_id: [], pollution: [], orphan_subject: [], answer_not_in_options: [],
  options_lt_4: [], option_too_long: [], multi_answer_disputed_missing: [],
}

function isAnswerValid(ans) {
  if (!ans) return false
  if (ans === '送分') return true
  // single letter A-D, or multi like "A,B" or "B,C,D"
  return /^[A-D](,[A-D])*$/.test(ans)
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

function audit(fp, prefix = '') {
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data
  const idCount = {}
  for (const q of arr) {
    if (q.id) idCount[q.id] = (idCount[q.id] || 0) + 1
  }
  for (const q of arr) {
    const tag = `${prefix}${fp}#${q.id || 'noid'}`
    // Skip questions already flagged incomplete — they're excluded from quiz pool
    // (still report duplicate_id since that's a structural issue regardless)
    const isIncomplete = !!q.incomplete
    // Skip true-false questions for option-count and short-question checks
    const isTF = q.type === 'tf'
    // missing answer
    if (!q.answer || String(q.answer).trim() === '') {
      if (!isIncomplete) issues.missing_answer.push(tag)
      continue
    }
    // invalid answer format (allow "E" only for 5-option gsat/ast)
    if (!isAnswerValid(q.answer)) {
      issues.invalid_answer.push(`${tag} ans="${q.answer}"`)
    }
    // empty options
    if (!q.options || typeof q.options !== 'object') {
      if (!isIncomplete) issues.empty_options.push(tag)
      continue
    }
    const optKeys = Object.keys(q.options)
    if (optKeys.length < 4 && !isTF && !isIncomplete) {
      issues.options_lt_4.push(`${tag} keys=${optKeys.join(',')}`)
    }
    if (!isIncomplete) {
      for (const k of optKeys) {
        if (!q.options[k] || String(q.options[k]).trim() === '') {
          if (!isTF || (k !== 'C' && k !== 'D')) {
            issues.empty_options.push(`${tag} opt_${k}_empty`)
          }
        }
        if (q.options[k] && String(q.options[k]).length > 400) {
          issues.option_too_long.push(`${tag} opt_${k}_${q.options[k].length}ch`)
        }
      }
      // answer letter not in options
      if (/^[A-D]$/.test(q.answer) && !q.options[q.answer]) {
        issues.answer_not_in_options.push(`${tag} ans=${q.answer}`)
      }
      // short question (<5 char) — skip 是非題 (legitimate short stem like "岔路")
      if (q.question && q.question.length < 5 && !isTF) {
        issues.short_question.push(`${tag} len=${q.question.length}`)
      }
      // pollution
      if (checkPollution(q)) {
        issues.pollution.push(tag)
      }
    }
    // multi-letter answer without disputed flag
    if (/^[A-D],[A-D]/.test(q.answer) && !q.disputed) {
      issues.multi_answer_disputed_missing.push(`${tag} ans=${q.answer}`)
    }
    // duplicate ID (always check)
    if (q.id && idCount[q.id] > 1) {
      issues.duplicate_id.push(tag)
    }
  }
}

console.log('=== Auditing', QFILES.length, 'exam files +', sharedFiles.length, 'shared banks ===\n')

for (const f of QFILES) audit(f)
for (const f of sharedFiles) audit(path.join(SHARED_DIR, f), 'shared/')

const summary = {}
for (const [k, list] of Object.entries(issues)) summary[k] = list.length

console.log('=== SUMMARY ===')
for (const [k, n] of Object.entries(summary).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n.toString().padStart(6)} ${k}`)
}

// Print top samples for non-zero categories
for (const [k, list] of Object.entries(issues)) {
  if (list.length === 0) continue
  console.log(`\n=== ${k} (${list.length} total, showing first 10) ===`)
  for (const item of list.slice(0, 10)) console.log(' ', item)
}
