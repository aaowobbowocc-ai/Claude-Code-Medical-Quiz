#!/usr/bin/env node
/**
 * 分析每個考試各卷別（subject）內 subject_tag 的分布。
 *
 * 期望：每張卷 subject 應該主要對應一個 subject_tag（>90%）。
 * 若一卷內 tag 分布 3/3/3 → 表示分類混亂或同卷涵蓋多 subject。
 *
 * 輸出：每卷的 tag 分布 + 偏離度評分（0=純淨, 1=均勻分散）。
 */
const fs = require('fs')
const path = require('path')

const TARGETS = [
  { exam: 'medlab', file: 'questions-medlab.json' },
  { exam: 'pt', file: 'questions-pt.json' },
  { exam: 'ot', file: 'questions-ot.json' },
]

function entropy(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (total === 0) return 0
  let h = 0
  for (const c of Object.values(counts)) {
    if (c === 0) continue
    const p = c / total
    h -= p * Math.log2(p)
  }
  // Normalize by max entropy (log2 of n unique tags)
  const maxH = Math.log2(Math.max(1, Object.keys(counts).length))
  return maxH > 0 ? h / maxH : 0
}

function analyze(examName, file) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf-8'))
  const questions = data.questions || (Array.isArray(data) ? data : [])

  // Group by subject (卷別), then count subject_tag
  const bySubject = new Map()
  for (const q of questions) {
    const subj = q.subject || '(no subject)'
    if (!bySubject.has(subj)) bySubject.set(subj, {})
    const tag = q.subject_tag || '(no tag)'
    bySubject.get(subj)[tag] = (bySubject.get(subj)[tag] || 0) + 1
  }

  console.log(`\n${'═'.repeat(70)}`)
  console.log(`📊 ${examName.toUpperCase()} — 共 ${questions.length} 題, ${bySubject.size} 個 subject`)
  console.log(`${'═'.repeat(70)}`)

  const issues = []
  for (const [subj, tagCounts] of bySubject.entries()) {
    const total = Object.values(tagCounts).reduce((a, b) => a + b, 0)
    const tags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1])
    const dominantTag = tags[0]
    const dominantPct = (dominantTag[1] / total * 100).toFixed(0)
    const h = entropy(tagCounts)

    let status = '✅'
    if (tags.length > 5) status = '🚨'
    else if (h > 0.4) status = '⚠'
    else if (tags.length > 2) status = '🟡'

    console.log(`\n${status} ${subj} (${total} 題, ${tags.length} tags, entropy=${h.toFixed(2)})`)
    for (const [tag, count] of tags.slice(0, 8)) {
      const pct = (count / total * 100).toFixed(0)
      const bar = '█'.repeat(Math.round(count / total * 40))
      console.log(`     ${tag.padEnd(28)} ${count.toString().padStart(5)} (${pct.padStart(2)}%) ${bar}`)
    }
    if (tags.length > 8) console.log(`     ... 還有 ${tags.length - 8} 個小 tag`)

    if (dominantPct < 70 || tags.length > 5) {
      issues.push({ exam: examName, subject: subj, total, tags: tags.length, dominantPct, entropy: h })
    }
  }

  return { exam: examName, total: questions.length, subjects: bySubject.size, issues }
}

const results = TARGETS.map(t => analyze(t.exam, t.file))

console.log(`\n${'═'.repeat(70)}`)
console.log('🎯 總結 — 需要關注的卷')
console.log(`${'═'.repeat(70)}`)
const allIssues = results.flatMap(r => r.issues)
if (allIssues.length === 0) {
  console.log('✅ 全部正常，無需處理')
} else {
  for (const i of allIssues) {
    console.log(`   ${i.exam.padEnd(8)} ${i.subject.padEnd(40)} ${i.tags} tags, 主 tag ${i.dominantPct}%, entropy=${i.entropy.toFixed(2)}`)
  }
}
