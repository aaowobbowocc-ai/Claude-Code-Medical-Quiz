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

function isAnswerValid(ans, optCount) {
  if (!ans) return false
  if (ans === '送分') return true
  // 五個選項的卷（學測／分科的 E、律師一試的複選題）答案可以到 E
  const last = optCount >= 5 ? 'E' : 'D'
  return new RegExp(`^[A-${last}](,[A-${last}])*$`).test(ans)
}

function checkPollution(q) {
  if (!q.question || !q.options) return false
  if (q.subject && /英文|英語/.test(q.subject)) return false
  // 題組情境／承上題已內嵌的題，題幹本來就是「情境 + 這一問」，
  // 第二段自然會和選項用字重疊，不是選項漏進題幹（見 project_followup_questions）
  if (/【題組情境】|承上題|承上圖|承前一題/.test(q.question)) return false
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
    // empty options
    if (!q.options || typeof q.options !== 'object') {
      if (!isIncomplete) issues.empty_options.push(tag)
      continue
    }
    const optKeys = Object.keys(q.options)
    // invalid answer format（選項到 E 的卷，答案就可以是 E）
    if (!isAnswerValid(q.answer, optKeys.length)) {
      issues.invalid_answer.push(`${tag} ans="${q.answer}"`)
    }
    // 駕照筆試的法規選擇題本來就是三選一（type='choice'），不是缺了一個選項。
    // 不排除的話這裡會固定報 1,465 題雜訊，真正的問題反而被蓋掉。
    const isDriverChoice = q.type === 'choice' && optKeys.length === 3
    if (optKeys.length < 4 && !isTF && !isDriverChoice && !isIncomplete) {
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
      // 駕照筆試的選擇題是「題幹(1)…(2)…(3)…。」的填空格式，
      // 題幹短到「機車」「騎車時應」是原本就這樣（公路局題庫原文已核對），不是被截斷。
      if (q.question && q.question.length < 5 && !isTF && q.type !== 'choice') {
        issues.short_question.push(`${tag} len=${q.question.length}`)
      }
      // pollution
      if (checkPollution(q)) {
        issues.pollution.push(tag)
      }
    }
    // multi-letter answer without disputed flag
    // 五個選項的卷有真正的**複選題**（律師一試綜合法學第 61 題以後），
    // 那種多重答案是題型本身，不是官方更正，不該要求 disputed。
    const isMultiChoiceQ = Object.keys(q.options || {}).length >= 5
    if (/^[A-E],[A-E]/.test(q.answer) && !q.disputed && !isMultiChoiceQ) {
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
