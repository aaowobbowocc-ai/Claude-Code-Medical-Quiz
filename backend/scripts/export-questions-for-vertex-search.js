#!/usr/bin/env node
/**
 * 把所有題庫匯出成 Vertex AI Search 能吃的 JSONL（NDJSON）。
 *
 * 一行一筆 JSON document，schema 跟 Vertex AI Search 「structured」data store
 * 對齊：每個 doc 有 id + structData + content（搜尋內文）。
 *
 * 用途：
 *   1. 題庫全文搜尋（#2）— 使用者輸入「fomepizole」找出所有相關題目
 *   2. 找類似題（#4）— semantic search 找出題幹相近的題目
 *   3. RAG retrieval（#3）— /explain 把相關題目當 context 送進 LLM
 *
 * 用法：
 *   node scripts/export-questions-for-vertex-search.js
 *     → 輸出 backend/_tmp/vertex-search/questions.jsonl
 *
 * 接下來：見 docs/VERTEX_AI_SEARCH_SETUP.md 把 JSONL 灌進 GCS 並建 data store。
 */
const fs = require('fs')
const path = require('path')

const BACKEND = path.join(__dirname, '..')
const CONFIG_DIR = path.join(BACKEND, 'exam-configs')
const OUT_DIR = path.join(BACKEND, '_tmp', 'vertex-search')
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })

const examNames = {}
for (const f of fs.readdirSync(CONFIG_DIR)) {
  if (!f.endsWith('.json')) continue
  const c = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, f), 'utf8'))
  examNames[c.id] = c.name
}

// Build a Vertex AI Search "structured data store" document. Schema:
//   - id:       globally unique (exam-id + numeric id) — required at top level
//   - structData: every searchable / filterable / displayable field lives here
//
// The "content" field inside structData is the primary search target (question
// stem + options joined). Vertex AI Search auto-indexes all string fields in
// structData for keyword search; semantic ranking on `content` can be enabled
// after the data store is created (via the schema editor, marking `content`
// as semanticSearchable). Top-level `content` is a separate concept used only
// for UNSTRUCTURED data stores (file/URI based) — putting plain text there
// would be silently ignored by a Structured data store.
function toDoc(q, examId) {
  const opts = q.options || {}
  const optionsText = ['A', 'B', 'C', 'D']
    .map(k => opts[k] ? `${k}. ${opts[k]}` : '')
    .filter(Boolean)
    .join('\n')
  const content = `${q.question || ''}\n${optionsText}`.trim()
  return {
    id: `${examId}_${q.id}`,
    structData: {
      // Primary search field — question stem + 4 options. Answer letter
      // intentionally NOT here so retrieval matches on semantics, not "B".
      content,
      // Display + filter metadata
      exam_id: examId,
      exam_name: examNames[examId] || examId,
      question_id: String(q.id),
      roc_year: q.roc_year || '',
      session: q.session || '',
      exam_code: q.exam_code || '',
      subject: q.subject || '',
      subject_tag: q.subject_tag || '',
      subject_name: q.subject_name || '',
      number: q.number || 0,
      answer: q.answer || '',
      disputed: !!q.disputed,
      incomplete: q.incomplete || null,
    },
  }
}

function loadQuestions(examId, file) {
  const fp = path.join(BACKEND, file)
  if (!fs.existsSync(fp)) return []
  const raw = JSON.parse(fs.readFileSync(fp, 'utf8'))
  return Array.isArray(raw) ? raw : raw.questions || []
}

const outPath = path.join(OUT_DIR, 'questions.jsonl')
const out = fs.createWriteStream(outPath)
let total = 0, skipped = 0
const perExam = {}

for (const examId of Object.keys(examNames)) {
  const cfgPath = path.join(CONFIG_DIR, `${examId}.json`)
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  const file = cfg.questionsFile
  if (!file) { skipped++; continue }
  const questions = loadQuestions(examId, file)
  let kept = 0
  for (const q of questions) {
    if (!q.question || !q.options || !q.answer) { skipped++; continue }
    if (q.incomplete) { skipped++; continue } // exclude broken questions from search
    const doc = toDoc(q, examId)
    out.write(JSON.stringify(doc) + '\n')
    kept++
    total++
  }
  perExam[examId] = kept
}
out.end()

console.log(`匯出 ${total} 題 → ${outPath}`)
console.log(`跳過 ${skipped} 題（含 incomplete / 缺欄位）`)
console.log('\n按 exam 分布：')
for (const k of Object.keys(perExam).sort()) {
  if (perExam[k]) console.log(`  ${k.padEnd(25)} ${perExam[k]}`)
}
console.log(`\n下一步：把 ${path.relative(BACKEND, outPath)} 上傳 GCS，依 docs/VERTEX_AI_SEARCH_SETUP.md 建 data store。`)
