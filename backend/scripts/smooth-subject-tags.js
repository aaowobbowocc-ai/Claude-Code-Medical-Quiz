#!/usr/bin/env node
/**
 * Neighbor-smoothing for subject_tag.
 *
 * Observation: within each (year, session, paper) block, questions are
 * ordered and grouped by subject (contiguous runs). If a single question's
 * tag differs from its surrounding window, it's almost certainly a
 * misclassification and should adopt the majority tag.
 *
 * Applies across all exams that use subject_tag for classification (doctor1,
 * doctor2, etc). Idempotent — stops when no changes occur in a full pass.
 *
 * Usage:
 *   node scripts/smooth-subject-tags.js --dry-run      # report only
 *   node scripts/smooth-subject-tags.js                # apply
 *   node scripts/smooth-subject-tags.js --exam doctor1 # single exam
 */

const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const examFilter = args.includes('--exam') ? args[args.indexOf('--exam') + 1] : null

const WINDOW = 3           // ± neighbors to look at
const MAJORITY = 4         // need this many of 7 (self + 6 neighbors) to override
const MAX_PASSES = 5

const FILES = [
  ['doctor1', 'questions.json'],
  ['doctor2', 'questions-doctor2.json'],
  ['dental1', 'questions-dental1.json'],
  ['dental2', 'questions-dental2.json'],
  ['pharma1', 'questions-pharma1.json'],
  ['pharma2', 'questions-pharma2.json'],
  ['tcm1', 'questions-tcm1.json'],
  ['tcm2', 'questions-tcm2.json'],
]

function smoothBlock(block) {
  // block: array of question objects, already sorted by number
  let changes = 0
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let passChanges = 0
    const originalTags = block.map(q => q.subject_tag)
    for (let i = 0; i < block.length; i++) {
      const lo = Math.max(0, i - WINDOW)
      const hi = Math.min(block.length - 1, i + WINDOW)
      const counts = {}
      for (let j = lo; j <= hi; j++) {
        const t = originalTags[j]
        if (!t) continue
        counts[t] = (counts[t] || 0) + 1
      }
      // find majority
      let bestTag = null, bestCnt = 0
      for (const [t, c] of Object.entries(counts)) {
        if (c > bestCnt) { bestCnt = c; bestTag = t }
      }
      if (!bestTag) continue
      if (bestCnt < MAJORITY) continue
      if (block[i].subject_tag === bestTag) continue
      block[i].subject_tag = bestTag
      passChanges++
    }
    changes += passChanges
    if (passChanges === 0) break
  }
  return changes
}

function processFile(examId, file) {
  const fp = path.join(__dirname, '..', file)
  if (!fs.existsSync(fp)) return
  const raw = JSON.parse(fs.readFileSync(fp, 'utf8'))
  const qs = Array.isArray(raw) ? raw : raw.questions

  // Group by (year, session, subject)
  const blocks = new Map()
  for (const q of qs) {
    if (!q.subject_tag) continue
    if (!q.number || typeof q.number !== 'number') continue
    const k = `${q.roc_year}|${q.session}|${q.subject}`
    if (!blocks.has(k)) blocks.set(k, [])
    blocks.get(k).push(q)
  }

  let totalChanges = 0
  let touchedBlocks = 0
  const changeLog = []
  for (const [key, block] of blocks) {
    block.sort((a, b) => a.number - b.number)
    const snapshot = block.map(q => q.subject_tag)
    const changes = smoothBlock(block)
    if (changes > 0) {
      totalChanges += changes
      touchedBlocks++
      // Capture diffs
      for (let i = 0; i < block.length; i++) {
        if (snapshot[i] !== block[i].subject_tag) {
          changeLog.push({ key, n: block[i].number, from: snapshot[i], to: block[i].subject_tag })
        }
      }
      if (DRY) for (let i = 0; i < block.length; i++) block[i].subject_tag = snapshot[i]
    }
  }
  if (DRY && changeLog.length) {
    console.log('  sample changes:')
    changeLog.slice(0, 15).forEach(c => console.log(`    ${c.key} Q${c.n}: ${c.from} → ${c.to}`))
  }

  console.log(examId.padEnd(10), 'changes:', String(totalChanges).padStart(5), 'across', touchedBlocks, 'blocks')
  if (!DRY && totalChanges > 0) {
    fs.writeFileSync(fp, JSON.stringify(raw, null, 2))
  }
  return totalChanges
}

console.log(`Neighbor smoothing (window=±${WINDOW}, majority=${MAJORITY}/7)${DRY ? ' [DRY-RUN]' : ''}`)
console.log('─'.repeat(60))
let total = 0
for (const [id, f] of FILES) {
  if (examFilter && examFilter !== id) continue
  total += processFile(id, f) || 0
}
console.log('─'.repeat(60))
console.log('Total tag changes:', total)
