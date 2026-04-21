#!/usr/bin/env node
// Coverage report v3: per-paper local-minimum detection.
// A session's count is "anomalous" only when it's strictly lower than BOTH
// chronological non-zero neighbors for the same paper. This correctly ignores
// structural exam changes (e.g., nursing 80→50 at 113, nutrition 40→50 at 113)
// while still catching isolated dips.
//
// Also detects:
//   - Mid-gaps: missing numbers within 1..expected in an existing paper
//   - Missing papers: paper entirely absent from a session where both
//     chronological neighbors have it
//
// Usage: node scripts/coverage-report.js [examId]

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const CONFIG_DIR = path.join(ROOT, 'exam-configs')
const onlyExam = process.argv[2] || null

const configs = {}
for (const f of fs.readdirSync(CONFIG_DIR).filter(f => f.endsWith('.json'))) {
  const c = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, f), 'utf8'))
  configs[c.id] = c
}

function loadQuestions(cfg) {
  const file = cfg.questionsFile || `questions-${cfg.id}.json`
  const p = path.join(ROOT, file)
  if (!fs.existsSync(p)) return []
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  return j.questions || j || []
}

const examIds = onlyExam ? [onlyExam] : Object.keys(configs).sort()

let totalMissing = 0
let totalSessions = 0
let totalIncompleteSessions = 0

for (const examId of examIds) {
  const cfg = configs[examId]
  if (!cfg) { console.log(`⚠ no config for ${examId}`); continue }

  const qs = loadQuestions(cfg)
  if (!qs.length) { console.log(`⚠ ${examId}: no questions file`); continue }

  // actual[year][session][subject] = Set(numbers)
  const actual = {}
  for (const q of qs) {
    const y = q.roc_year, s = q.session, subj = q.subject
    if (!actual[y]) actual[y] = {}
    if (!actual[y][s]) actual[y][s] = {}
    if (!actual[y][s][subj]) actual[y][s][subj] = new Set()
    actual[y][s][subj].add(q.number)
  }

  // Chronological timeline for this exam (only sessions actually observed)
  const timeline = []
  for (const y of Object.keys(actual).sort()) {
    for (const s of Object.keys(actual[y]).sort()) {
      timeline.push({ year: y, session: s })
    }
  }

  // All papers seen anywhere in this exam
  const allPapers = new Set()
  for (const yData of Object.values(actual))
    for (const sData of Object.values(yData))
      for (const subj of Object.keys(sData))
        allPapers.add(subj)

  // For each paper, expected count per timeline slot via local-minimum rule:
  //   - present count is only anomalous if strictly < both nearest non-zero neighbors
  //   - absent paper (count 0) is only anomalous if both neighbors exist
  const expectedByPaper = {}
  for (const subj of allPapers) {
    const counts = timeline.map(({ year, session }) => {
      const set = actual[year][session][subj]
      return set ? set.size : 0
    })
    const n = counts.length
    const expected = new Array(n)
    for (let i = 0; i < n; i++) {
      const curr = counts[i]
      let prev = null
      for (let j = i - 1; j >= 0; j--) if (counts[j] > 0) { prev = counts[j]; break }
      let next = null
      for (let j = i + 1; j < n; j++) if (counts[j] > 0) { next = counts[j]; break }

      if (curr === 0) {
        // Paper absent here; flag only if surrounded on both sides
        expected[i] = (prev !== null && next !== null) ? Math.max(prev, next) : 0
      } else {
        const pv = prev ?? curr
        const nv = next ?? curr
        // Strictly lower than both neighbors → isolated dip, expected = higher neighbor
        if (curr < pv && curr < nv) expected[i] = Math.max(pv, nv)
        else expected[i] = curr
      }
    }
    expectedByPaper[subj] = expected
  }

  console.log(`\n=== ${examId} (${cfg.name}) ===`)

  let examMissing = 0
  let examSessions = 0
  let examIncomplete = 0

  for (let i = 0; i < timeline.length; i++) {
    const { year: y, session: s } = timeline[i]
    examSessions++
    const sData = actual[y][s]
    const lines = []
    let sessionMissing = 0

    for (const subj of allPapers) {
      const expectN = expectedByPaper[subj][i]
      const got = sData[subj]

      if (!got) {
        if (expectN > 0) {
          lines.push(`     ${subj.padEnd(22)}  ${String(0).padStart(3)}/${String(expectN).padStart(3)}  ❌ paper missing`)
          sessionMissing += expectN
        }
        continue
      }

      const have = got.size
      // Mid-gaps within 1..expectN
      const missingNums = []
      for (let k = 1; k <= expectN; k++) if (!got.has(k)) missingNums.push(k)
      if (missingNums.length > 0) {
        const showNums = missingNums.length <= 8
          ? `[${missingNums.join(',')}]`
          : `[${missingNums.slice(0, 6).join(',')},...+${missingNums.length - 6}]`
        lines.push(`     ${subj.padEnd(22)}  ${String(have).padStart(3)}/${String(expectN).padStart(3)}  ${showNums}`)
        sessionMissing += missingNums.length
      }
    }

    if (sessionMissing > 0) {
      console.log(`  ${y} ${s}                        ⚠ ${sessionMissing} missing`)
      for (const l of lines) console.log(l)
      examIncomplete++
    }
    examMissing += sessionMissing
  }

  if (examMissing === 0) {
    console.log(`  ✓ all ${examSessions} sessions complete`)
  } else {
    console.log(`  TOTAL ${examMissing} missing across ${examIncomplete}/${examSessions} sessions`)
  }
  totalMissing += examMissing
  totalSessions += examSessions
  totalIncompleteSessions += examIncomplete
}

console.log(`\n${'═'.repeat(60)}`)
if (totalMissing === 0) {
  console.log(`✓ GRAND TOTAL: ${totalSessions} sessions across ${examIds.length} exams, all complete`)
} else {
  console.log(`GRAND TOTAL: ${totalMissing} missing across ${totalIncompleteSessions}/${totalSessions} sessions in ${examIds.length} exams`)
}
console.log(`\nNote: uses per-paper local-minimum detection. A session's count is only`)
console.log(`flagged when it's strictly lower than both chronological non-zero neighbors`)
console.log(`for the same paper, so structural exam changes are ignored.`)
