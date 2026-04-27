#!/usr/bin/env node
/**
 * 將每筆題目的 subject_name 同步成 exam-config 裡 stages[].name 的權威值。
 *
 * 為什麼需要：
 *   - subject_tag 是分類用的英文 key（會被 classifier/smoother 改）
 *   - subject_name 是顯示用的中文名稱
 *   - 之前 ingest 時 name 寫錯（例如 tag=microbiology / name=生物化學），classifier
 *     之後只動了 tag 沒動 name → 造成 2,300+ 題 mismatch（doctor1）
 *
 * Source of truth:
 *   exam-configs/{exam}.json 的 stages[].name（每個 tag 對應的中文）
 *
 * Usage:
 *   node scripts/sync-subject-names.js --dry-run   # 只 report
 *   node scripts/sync-subject-names.js             # 寫入
 *   node scripts/sync-subject-names.js --exam doctor1
 */

const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const examFilter = args.includes('--exam') ? args[args.indexOf('--exam') + 1] : null

const EXAMS = [
  ['doctor1', 'questions.json'],
  ['doctor2', 'questions-doctor2.json'],
  ['dental1', 'questions-dental1.json'],
  ['dental2', 'questions-dental2.json'],
  ['pharma1', 'questions-pharma1.json'],
  ['pharma2', 'questions-pharma2.json'],
  ['tcm1',    'questions-tcm1.json'],
  ['tcm2',    'questions-tcm2.json'],
]

// 卷別命名 pattern（subject_name 是卷別名而非專科名 → 應該被取代）
//   match: 醫學(一)~(六) / 牙醫學(一)~(六) / 卷一~六 / paper1~6
//   not match: 醫學倫理與法規（雖然開頭是「醫學」但不是卷別格式）
const PAPER_NAME_RE = /^(醫學|牙醫學)\s*[（(]\s*[一二三四五六]\s*[）)]$|^卷[一二三四五六七八]$|^paper\s*\d+$/i

function loadTagMap(examId, questions) {
  const cfgPath = path.join(__dirname, '..', 'exam-configs', examId + '.json')
  if (!fs.existsSync(cfgPath)) return null
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
  const map = {}
  // Source of truth #1: stages[].name (完整中文名，如 "微生物與免疫")
  if (Array.isArray(cfg.stages)) {
    for (const s of cfg.stages) {
      if (s.tag && s.tag !== 'all' && s.name) map[s.tag] = s.name
    }
  }
  // Source of truth #2 (fallback): 從現有資料推導 canonical name
  // 規則：對該 tag 的所有 subject_name 變體，挑「非卷別命名」中題數最多的當 canonical
  // 用途：doctor2/dental1/dental2 的 stages 只有 'all'，但歷史資料裡有正確的專科名
  const tagsNeedingInference = new Set()
  for (const q of questions) {
    if (q.subject_tag && !map[q.subject_tag]) tagsNeedingInference.add(q.subject_tag)
  }
  if (tagsNeedingInference.size > 0) {
    const candidates = {}
    for (const q of questions) {
      if (!tagsNeedingInference.has(q.subject_tag)) continue
      if (!q.subject_name) continue
      if (PAPER_NAME_RE.test(q.subject_name)) continue  // 跳過卷別名
      candidates[q.subject_tag] = candidates[q.subject_tag] || {}
      candidates[q.subject_tag][q.subject_name] = (candidates[q.subject_tag][q.subject_name] || 0) + 1
    }
    for (const [tag, names] of Object.entries(candidates)) {
      const sorted = Object.entries(names).sort((a, b) => b[1] - a[1])
      if (sorted.length > 0) map[tag] = sorted[0][0]
    }
  }
  return map
}

function processExam(examId, file) {
  const fp = path.join(__dirname, '..', file)
  if (!fs.existsSync(fp)) {
    console.log(`${examId.padEnd(10)} (no file)`)
    return 0
  }
  const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const qs = Array.isArray(raw) ? raw : raw.questions

  const tagMap = loadTagMap(examId, qs)
  if (!tagMap || Object.keys(tagMap).length === 0) {
    console.log(`${examId.padEnd(10)} (no stages or inferable names)`)
    return 0
  }

  let touched = 0, untracked = 0
  const sample = []
  for (const q of qs) {
    if (!q.subject_tag) continue
    const expected = tagMap[q.subject_tag]
    if (!expected) {
      // tag 不在 config 裡 — 可能是 paper-level name (e.g., 醫學(一)) 或 legacy tag
      untracked++
      continue
    }
    if (q.subject_name !== expected) {
      if (sample.length < 5) {
        sample.push(`Q${q.number} [${q.subject_tag}] "${q.subject_name}" → "${expected}"`)
      }
      q.subject_name = expected
      touched++
    }
  }

  console.log(`${examId.padEnd(10)} synced: ${String(touched).padStart(5)}  (untracked tags: ${untracked})`)
  if (DRY && sample.length > 0) {
    sample.forEach(s => console.log(`  ${s}`))
  }

  if (!DRY && touched > 0) {
    const tmp = fp + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2))
    fs.renameSync(tmp, fp)
  }
  return touched
}

console.log(`Sync subject_name from exam-config stages[].name${DRY ? ' [DRY-RUN]' : ''}`)
console.log('─'.repeat(60))
let total = 0
for (const [id, f] of EXAMS) {
  if (examFilter && examFilter !== id) continue
  total += processExam(id, f)
}
console.log('─'.repeat(60))
console.log(`Total synced: ${total}${DRY ? ' (dry-run, no write)' : ''}`)
