#!/usr/bin/env node
/**
 * Fix 承上題 (follow-up / grouped) questions by binding them to their stem.
 *
 * For each question whose `question` starts with 「承上題」, walk back by
 * (exam_code, session, subject, number-1) to find the stem (first non-承上題
 * in the chain). Then:
 *   - Set `case_context` = stem question + options + answer (formatted)
 *   - Copy stem's `images` array to the follow-up question's `images`
 *
 * Idempotent: if `case_context` already present and matches, skip.
 * Also normalizes medlab's legacy inline format (【承上題．前情提要】) into
 * the case_context field.
 */

const fs = require('fs')
const path = require('path')

const BACKEND_DIR = path.join(__dirname, '..')
const FILES = fs.readdirSync(BACKEND_DIR)
  .filter(f => f.startsWith('questions') && f.endsWith('.json') && !f.includes('backup'))
  .map(f => path.join(BACKEND_DIR, f))

function buildContext(stem) {
  const lines = []
  lines.push(`第 ${stem.number} 題：${stem.question}`)
  if (stem.options) {
    for (const [k, v] of Object.entries(stem.options)) {
      lines.push(`(${k}) ${v}`)
    }
  }
  if (stem.answer) {
    const ansKey = String(stem.answer).trim()
    const ansText = stem.options?.[ansKey]
    lines.push(ansText ? `上題答案：(${ansKey}) ${ansText}` : `上題答案：${ansKey}`)
  }
  return lines.join('\n')
}

function stripLegacyPrefix(questionText) {
  // Matches the medlab scraper's legacy format:
  //   【承上題．前情提要】\n...\n──────────\n<real question>
  const divider = /──────────\n?/
  if (questionText.startsWith('【承上題．前情提要】')) {
    const parts = questionText.split(divider)
    if (parts.length >= 2) {
      return parts.slice(1).join('──────────\n').trim()
    }
  }
  return questionText
}

function processFile(filepath) {
  const raw = JSON.parse(fs.readFileSync(filepath, 'utf8'))
  const questions = Array.isArray(raw) ? raw : raw.questions

  // Build lookup by (exam_code, subject, number)
  const keyOf = q => `${q.exam_code}|${q.subject}|${q.number}`
  const byKey = new Map()
  for (const q of questions) byKey.set(keyOf(q), q)

  let processed = 0
  let skipped = 0
  let normalized = 0
  const chainTooLong = []
  const orphans = []

  for (const q of questions) {
    if (!q.question) continue

    // Normalize legacy inline prefix first
    const originalQ = q.question
    const stripped = stripLegacyPrefix(originalQ)
    if (stripped !== originalQ) {
      q.question = stripped
      normalized++
    }

    if (!q.question.startsWith('承上題')) continue

    // Walk back up to 10 steps to find stem
    let stem = null
    let n = q.number - 1
    for (let i = 0; i < 10 && n >= 1; i++, n--) {
      const prev = byKey.get(`${q.exam_code}|${q.subject}|${n}`)
      if (!prev) break
      if (!prev.question?.startsWith('承上題')) { stem = prev; break }
    }

    if (!stem) {
      orphans.push(`${filepath.split(/[\\/]/).pop()} ${q.exam_code} ${q.subject} Q${q.number} id=${q.id}`)
      continue
    }

    const context = buildContext(stem)

    // Idempotency: skip if already correct
    if (q.case_context === context && JSON.stringify(q.images || null) === JSON.stringify(stem.images || null)) {
      skipped++
      continue
    }

    q.case_context = context
    if (stem.images && stem.images.length) {
      q.images = [...stem.images]
    }
    processed++
  }

  // Preserve outer shape
  const out = Array.isArray(raw) ? questions : { ...raw, questions }
  fs.writeFileSync(filepath, JSON.stringify(out, null, 2))

  const name = path.basename(filepath)
  console.log(`${name}: processed=${processed}, normalized=${normalized}, already-correct=${skipped}, orphans=${orphans.length}`)
  if (chainTooLong.length) console.log('  chain>10:', chainTooLong.slice(0, 5))
  if (orphans.length) console.log('  orphans (stem not found):', orphans.slice(0, 10))
}

for (const f of FILES) processFile(f)
