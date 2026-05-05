#!/usr/bin/env node
/**
 * Audit each exam: compare actual question counts per (year, session, subject)
 * against expected counts from exam-configs. Report missing/incomplete papers
 * so the user can manually search for the correct PDF on MoEX.
 *
 * Output:
 *   - Per exam, list of (year, session, subject) groups where count < expected
 *   - "MISSING" if count = 0 (whole paper absent)
 *   - "PARTIAL: X/Y" if some questions present but not all
 */

const fs = require('fs')
const path = require('path')

const BACKEND = path.join(__dirname, '..')

function loadConfig(examId) {
  const f = path.join(BACKEND, 'exam-configs', `${examId}.json`)
  if (!fs.existsSync(f)) return null
  return JSON.parse(fs.readFileSync(f, 'utf8'))
}

function loadQuestions(file) {
  const f = path.join(BACKEND, file)
  if (!fs.existsSync(f)) return []
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'))
  return Array.isArray(raw) ? raw : (raw.questions || [])
}

function audit(examId) {
  const cfg = loadConfig(examId)
  if (!cfg || !cfg.papers || !cfg.questionsFile) return null
  const questions = loadQuestions(cfg.questionsFile)
  if (!questions.length) return { examId, examName: cfg.name, missing: [] }

  // Group by (roc_year, session, subject)
  const grouped = {}
  for (const q of questions) {
    if (!q.roc_year || !q.session || !q.subject) continue
    const key = `${q.roc_year}|${q.session}|${q.subject}`
    grouped[key] = (grouped[key] || 0) + 1
  }

  // Discover which years/sessions exist for this exam
  const yearSessions = new Set()
  for (const q of questions) {
    if (q.roc_year && q.session) yearSessions.add(`${q.roc_year}|${q.session}`)
  }

  // For each year-session, compare each paper subject
  const issues = []
  for (const ys of [...yearSessions].sort()) {
    const [year, session] = ys.split('|')
    for (const paper of cfg.papers) {
      const subject = paper.subject || paper.name
      const expected = paper.count || 80
      const actual = grouped[`${year}|${session}|${subject}`] || 0
      if (actual === expected) continue
      if (actual === 0) {
        issues.push({ year, session, subject, status: 'MISSING', expected, actual: 0 })
      } else if (actual < expected) {
        issues.push({ year, session, subject, status: 'PARTIAL', expected, actual })
      } else if (actual > expected) {
        issues.push({ year, session, subject, status: 'OVER', expected, actual })
      }
    }
  }
  return { examId, examName: cfg.name, papers: cfg.papers.length, perSession: cfg.papers.reduce((s,p) => s + (p.count || 0), 0), issues }
}

const EXAMS = ['doctor1','doctor2','dental1','dental2','pharma1','pharma2','nursing','nutrition','medlab','pt','ot','radiology','tcm1','tcm2','vet','social-worker']

// "Expected missing" — sessions/years that legitimately don't exist (exam not
// held, exam started later, future year). Format: { exam: ['year-session', ...] }
const EXPECTED_MISSING = (() => {
  const m = {}
  // 115年第二次 not held yet (typical 8月 timing) — applies to all exams
  for (const e of EXAMS) m[e] = new Set(['115-2'])
  // 職治師/獸醫師 從 110 起只辦第二次（年度單試）
  for (const e of ['ot', 'vet']) {
    for (let y = 110; y <= 115; y++) m[e].add(`${y}-1`)
  }
  // 社工師 104 年才開辦
  m['social-worker'] = new Set([...m['social-worker']])
  for (let y = 100; y <= 103; y++) {
    m['social-worker'].add(`${y}-1`); m['social-worker'].add(`${y}-2`)
  }
  return m
})()

function reportMissingYears() {
  console.log('\n=== 100-115 全年度覆蓋檢查 ===')
  for (const examId of EXAMS) {
    const cfg = loadConfig(examId)
    if (!cfg || !cfg.questionsFile) continue
    const arr = loadQuestions(cfg.questionsFile)
    const present = new Set()
    for (const q of arr) {
      if (q.roc_year && q.session) {
        present.add(`${q.roc_year}-${q.session === '第一次' ? '1' : '2'}`)
      }
    }
    const missing = []
    for (let y = 100; y <= 115; y++) {
      for (const sid of ['1', '2']) {
        const key = `${y}-${sid}`
        if (!present.has(key) && !EXPECTED_MISSING[examId].has(key)) missing.push(key)
      }
    }
    if (missing.length) {
      console.log(`❌ ${cfg.name} (${examId}): 真實缺漏 ${missing.join(', ')}`)
    } else {
      console.log(`✅ ${cfg.name} (${examId}): 100-115 已知該辦的場次都有`)
    }
  }
}

reportMissingYears()

let totalIssues = 0
let totalMissing = 0
for (const examId of EXAMS) {
  const r = audit(examId)
  if (!r) continue
  if (!r.issues.length) {
    console.log(`✅ ${r.examName} (${examId}): all papers complete`)
    continue
  }
  // Group by status
  const missing = r.issues.filter(i => i.status === 'MISSING')
  const partial = r.issues.filter(i => i.status === 'PARTIAL')
  const over    = r.issues.filter(i => i.status === 'OVER')
  // Only flag actionable issues:
  //   - MISSING (count = 0)              fully missing paper
  //   - SEVERE_PARTIAL (count < 50%)     PDF likely missing or scrape failed
  // Skip OVER (older format had more questions per paper, e.g. nursing 80→50 in 113+)
  // Skip mild PARTIAL (off by 1-2 = scrape oddity, not a missing PDF)
  const severe = partial.filter(i => i.actual < i.expected * 0.5)
  if (missing.length === 0 && severe.length === 0) {
    console.log(`✅ ${r.examName} (${examId}): no fully-missing papers`)
    continue
  }
  if (missing.length) {
    console.log(`\n=== ${r.examName} (${examId}) ===`)
    console.log(`  ❌ 完全缺少 ${missing.length} 份試卷（總計 ${missing.reduce((s,i)=>s+i.expected,0)} 題）：`)
    for (const i of missing) console.log(`     ${i.year}年 ${i.session} ${i.subject} (預期 ${i.expected} 題)`)
  }
  if (severe.length) {
    if (!missing.length) console.log(`\n=== ${r.examName} (${examId}) ===`)
    console.log(`  ⚠️  嚴重缺漏 ${severe.length} 份（< 50% 完整度）：`)
    for (const i of severe) console.log(`     ${i.year}年 ${i.session} ${i.subject}: ${i.actual}/${i.expected}`)
  }
  totalIssues += missing.length + severe.length
  totalMissing += missing.length
}

console.log('\n' + '='.repeat(60))
console.log(`TOTAL: ${totalIssues} issues across exams (${totalMissing} fully missing papers)`)
