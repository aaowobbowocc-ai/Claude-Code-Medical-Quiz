#!/usr/bin/env node
// Scan all multi-paper exams for paper/tag inconsistency.
// For each exam, build expected tag→subject mapping from data majority, then
// count questions where (subject, subject_tag) deviates from majority.
const fs = require('fs')

const QFILES = fs.readdirSync('.').filter(f => /^questions(-[\w-]+)?\.json$/.test(f))
const issues = []

for (const f of QFILES) {
  const data = JSON.parse(fs.readFileSync(f, 'utf-8'))
  const arr = data.questions || data
  // Build tag → subject distribution
  const tagToSubj = {}
  for (const q of arr) {
    if (!q.subject_tag || !q.subject) continue
    if (!tagToSubj[q.subject_tag]) tagToSubj[q.subject_tag] = {}
    tagToSubj[q.subject_tag][q.subject] = (tagToSubj[q.subject_tag][q.subject] || 0) + 1
  }
  // For each tag, find majority subject, count outliers
  const mismatches = []
  for (const [tag, subjCounts] of Object.entries(tagToSubj)) {
    const entries = Object.entries(subjCounts).sort((a, b) => b[1] - a[1])
    const total = entries.reduce((s, [, n]) => s + n, 0)
    const majority = entries[0]
    if (total < 20) continue // ignore rare tags
    const majorityRatio = majority[1] / total
    if (majorityRatio < 0.95 && majority[1] - entries[1]?.[1] > 5) {
      // Significant split — could be legitimate (e.g., shared tag) or a bug
      mismatches.push({ tag, subjects: entries.map(([s, n]) => `${s}=${n}`).join(', '), total })
    }
  }
  if (mismatches.length > 0) {
    issues.push({ file: f, mismatches })
  }
}

for (const issue of issues) {
  console.log(`\n=== ${issue.file} ===`)
  for (const m of issue.mismatches) {
    console.log(`  ${m.tag} (${m.total} total):`)
    console.log(`    ${m.subjects}`)
  }
}
