#!/usr/bin/env node
/**
 * scan-truncated.js — 掃描所有題庫 JSON，找出被截斷/不完整的題目
 *
 * 檢查項目：
 * 1. 題目文字過短（< 10 字）
 * 2. 題目文字結尾像被截斷（結尾是半個括號、半個選項標記等）
 * 3. 選項缺少（不足 4 個 A/B/C/D）
 * 4. 選項內容為空字串
 * 5. 選項內容過短（< 2 字，排除純字母/數字答案）
 * 6. 題目文字中有序號列表被截斷（如 ①②③ 後突然結束）
 *
 * Usage:
 *   node scripts/scan-truncated.js                    # 掃描全部
 *   node scripts/scan-truncated.js --exam nursing     # 只掃某考試
 *   node scripts/scan-truncated.js --verbose          # 顯示詳細資訊
 */

const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)
const examFilter = args.includes('--exam') ? args[args.indexOf('--exam') + 1] : null
const verbose = args.includes('--verbose')

const BACKEND = path.resolve(__dirname, '..')
// Skip driver exams (3-option format by design) and backups
const SKIP_PATTERNS = ['driver-car', 'driver-moto', '_backup']
const QUESTION_FILES = fs.readdirSync(BACKEND)
  .filter(f => f.startsWith('questions') && f.endsWith('.json') && !SKIP_PATTERNS.some(p => f.includes(p)))
  .map(f => path.join(BACKEND, f))

// ─── Truncation heuristics ───

function checkTruncated(q) {
  const issues = []
  const text = (q.question || '').trim()
  const opts = q.options || {}
  const optKeys = Object.keys(opts)

  // 1. Question text too short
  if (text.length > 0 && text.length < 10) {
    issues.push(`題目過短 (${text.length} 字): "${text}"`)
  }

  // 2. Question text ends abruptly (mid-word/mid-list)
  if (text.length > 0) {
    // Ends with a circled number marker but no content after it (e.g., "②社區精神")
    // Check if the last part is an incomplete numbered item
    const circledMatch = text.match(/[①②③④⑤⑥⑦⑧⑨⑩]\s*[\u4e00-\u9fff\w]{0,6}$/)
    if (circledMatch) {
      const after = circledMatch[0]
      // If the text before has more circled items, this might be truncated
      const allCircled = text.match(/[①②③④⑤⑥⑦⑧⑨⑩]/g)
      if (allCircled && allCircled.length >= 2) {
        // Check if the last circled item's content is suspiciously short compared to earlier ones
        const lastIdx = text.lastIndexOf(circledMatch[0].charAt(0))
        const lastContent = text.substring(lastIdx + 1).trim()
        // Find earlier items' content lengths
        const parts = text.split(/[①②③④⑤⑥⑦⑧⑨⑩]/).filter(Boolean)
        if (parts.length >= 2) {
          const avgLen = parts.slice(0, -1).reduce((s, p) => s + p.trim().length, 0) / (parts.length - 1)
          if (lastContent.length < avgLen * 0.4 && lastContent.length < 8) {
            issues.push(`題目列表可能被截斷: 最後項 "${lastContent}" (${lastContent.length}字) vs 平均 ${avgLen.toFixed(0)}字`)
          }
        }
      }
    }

    // Ends mid-parenthesis
    if (/[（(][^）)]{0,3}$/.test(text) && text.length > 20) {
      issues.push(`題目結尾括號未閉合: "...${text.slice(-20)}"`)
    }

    // Ends with a lone connector that suggests more text was expected
    if (/[、，；及與或]\s*$/.test(text)) {
      issues.push(`題目以連接詞結尾: "...${text.slice(-15)}"`)
    }
  }

  // 3. Missing options (fewer than expected A/B/C/D)
  const expectedOpts = ['A', 'B', 'C', 'D']
  const missing = expectedOpts.filter(k => !(k in opts))
  if (missing.length > 0 && optKeys.length > 0) {
    issues.push(`缺少選項: ${missing.join(', ')}`)
  }
  if (optKeys.length === 0) {
    issues.push('完全沒有選項')
  }

  // 4. Empty option values
  for (const [k, v] of Object.entries(opts)) {
    if (typeof v === 'string' && v.trim() === '') {
      issues.push(`選項 ${k} 為空字串`)
    }
  }

  // 5. Suspiciously short options (but allow single-char answers like numbers, letters)
  for (const [k, v] of Object.entries(opts)) {
    if (typeof v === 'string') {
      const trimmed = v.trim()
      // Skip if it's a number, single letter, or common short answer
      if (trimmed.length === 1 && /[\d\w]/.test(trimmed)) continue
      if (trimmed.length > 0 && trimmed.length < 2 && !/^[\d]+$/.test(trimmed)) {
        issues.push(`選項 ${k} 過短 (${trimmed.length}字): "${trimmed}"`)
      }
    }
  }

  // 6. Question text is empty
  if (!text) {
    issues.push('題目文字為空')
  }

  // 7. Option text looks truncated (ends with open bracket, comma, etc.)
  for (const [k, v] of Object.entries(opts)) {
    if (typeof v === 'string' && v.trim().length > 5) {
      const t = v.trim()
      if (/[（(][^）)]{0,3}$/.test(t)) {
        issues.push(`選項 ${k} 括號未閉合: "...${t.slice(-15)}"`)
      }
      if (/[、，；]\s*$/.test(t)) {
        issues.push(`選項 ${k} 以連接詞結尾: "...${t.slice(-15)}"`)
      }
    }
  }

  // 8. Answer is missing or invalid
  if (!q.answer || !/^[A-D]$/.test(q.answer)) {
    issues.push(`答案異常: "${q.answer || '(空)'}"`)
  }

  return issues
}

// ─── Main scan ───

let totalIssues = 0
let totalQuestions = 0
const allIssues = []

for (const filePath of QUESTION_FILES) {
  const basename = path.basename(filePath)

  // Filter by exam if specified
  if (examFilter) {
    const examId = basename.replace('questions-', '').replace('questions', 'doctor1').replace('.json', '')
    if (examId !== examFilter && basename !== `questions-${examFilter}.json`) continue
  }

  let questions
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    // Support both { questions: [...] } and plain array formats
    questions = Array.isArray(raw) ? raw : (raw.questions || [])
  } catch (e) {
    console.error(`❌ 無法讀取 ${basename}: ${e.message}`)
    continue
  }

  if (!Array.isArray(questions) || questions.length === 0) continue

  const fileIssues = []
  for (const q of questions) {
    const issues = checkTruncated(q)
    if (issues.length > 0) {
      fileIssues.push({ id: q.id, year: q.roc_year, session: q.session, subject: q.subject, number: q.number, issues, question: q.question, options: q.options })
    }
  }

  totalQuestions += questions.length

  if (fileIssues.length > 0) {
    console.log(`\n📋 ${basename} (${questions.length} 題, ${fileIssues.length} 問題)`)
    console.log('─'.repeat(60))

    for (const item of fileIssues) {
      console.log(`  🔴 ${item.id} | ${item.year}/${item.session} ${item.subject} #${item.number}`)
      for (const issue of item.issues) {
        console.log(`     ⚠ ${issue}`)
      }
      if (verbose) {
        console.log(`     題目: ${(item.question || '').substring(0, 80)}...`)
        if (item.options) {
          for (const [k, v] of Object.entries(item.options)) {
            console.log(`     ${k}: ${(v || '').substring(0, 60)}`)
          }
        }
      }
    }

    totalIssues += fileIssues.length
    allIssues.push(...fileIssues.map(i => ({ file: basename, ...i })))
  } else if (verbose) {
    console.log(`✅ ${basename} (${questions.length} 題) — 無問題`)
  }
}

console.log('\n' + '═'.repeat(60))
console.log(`掃描完成: ${totalQuestions} 題, ${totalIssues} 題有問題`)

if (allIssues.length > 0) {
  // Group by issue type for summary
  const byType = {}
  for (const item of allIssues) {
    for (const issue of item.issues) {
      const type = issue.split(':')[0].split('(')[0].trim()
      if (!byType[type]) byType[type] = []
      byType[type].push(item.id)
    }
  }
  console.log('\n問題類型統計:')
  for (const [type, ids] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${type}: ${ids.length} 題`)
  }

  // Write detailed report
  const reportPath = path.join(BACKEND, '_tmp', 'truncated-report.json')
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(allIssues, null, 2))
  console.log(`\n詳細報告已寫入: ${reportPath}`)
}
