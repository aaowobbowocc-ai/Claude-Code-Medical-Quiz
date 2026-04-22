#!/usr/bin/env node
// Re-tag nursing sub-subjects by paper + question-number range.
// 護理師 papers 混用 50 題 (新制 111+/113+/114+) 與 80 題 (舊制) 格式。
// 實測確認：所有 paper 的子科目邊界都是 proportional split。
//
// 50 題格式：
//   基礎醫學:         解剖10 + 生理10 + 病理10 + 藥理10 + 微免10 (實測均分，非 config 的 10/12/10/10/8)
//   基本護理+行政:    基本護理35 + 行政15
//   內外科:           內科30 + 外科20
//   產兒:             產科25 + 兒科25
//   精神+社區:        精神25 + 社區25
//
// 80 題格式（×1.6）：
//   基礎醫學:         16/16/16/16/16 均分
//   基本護理+行政:    56/24
//   內外科:           48/32
//   產兒:             40/40
//   精神+社區:        40/40
//
// 75-79 題年度（scrape incomplete）套 80 題規則，超出範圍的題號依比例分到最後一段。

const fs = require('fs')
const path = require('path')
const QFILE = path.join(__dirname, '..', 'questions-nursing.json')

// Per-paper per-format rule. Each entry: [to, tag, name, stage_id]
const PAPER_RULES = {
  '基礎醫學': {
    50: [
      [10, 'anatomy',       '解剖學', 1],
      [20, 'physiology',    '生理學', 2],
      [30, 'pathology',     '病理學', 3],
      [40, 'pharmacology',  '藥理學', 4],
      [50, 'microimmuno',   '微生物免疫學', 5],
    ],
    80: [
      [16, 'anatomy',       '解剖學', 1],
      [32, 'physiology',    '生理學', 2],
      [48, 'pathology',     '病理學', 3],
      [64, 'pharmacology',  '藥理學', 4],
      [80, 'microimmuno',   '微生物免疫學', 5],
    ],
  },
  '基本護理學與護理行政': {
    50: [
      [35, 'fundamental_nursing', '基本護理學',   6],
      [50, 'nursing_admin',       '護理行政',     7],
    ],
    80: [
      [56, 'fundamental_nursing', '基本護理學',   6],
      [80, 'nursing_admin',       '護理行政',     7],
    ],
  },
  '內外科護理學': {
    50: [
      [30, 'internal_nursing', '內科護理學', 8],
      [50, 'surgical_nursing', '外科護理學', 9],
    ],
    80: [
      [48, 'internal_nursing', '內科護理學', 8],
      [80, 'surgical_nursing', '外科護理學', 9],
    ],
  },
  '產兒科護理學': {
    50: [
      [25, 'obstetric_nursing', '產科護理學', 10],
      [50, 'pediatric_nursing', '兒科護理學', 11],
    ],
    80: [
      [40, 'obstetric_nursing', '產科護理學', 10],
      [80, 'pediatric_nursing', '兒科護理學', 11],
    ],
  },
  '精神科與社區衛生護理學': {
    50: [
      [25, 'psychiatric_nursing', '精神科護理學', 12],
      [50, 'community_nursing',   '社區護理學',   13],
    ],
    80: [
      [40, 'psychiatric_nursing', '精神科護理學', 12],
      [80, 'community_nursing',   '社區護理學',   13],
    ],
  },
}

// Group questions by subject + roc_year + session so we can detect paper length.
function buildLengthIndex(arr) {
  const idx = {}
  for (const q of arr) {
    const key = `${q.subject}|${q.roc_year}|${q.session || ''}`
    idx[key] = (idx[key] || 0) + 1
  }
  return idx
}

function pickFormat(len) {
  // <= 55 → treat as 50-题 format; else 80-题 (covers 75-79 scrape-anomalies).
  return len <= 55 ? 50 : 80
}

function classify(q, lengthIdx) {
  const rules = PAPER_RULES[q.subject]
  if (!rules) return null
  const n = q.number
  if (typeof n !== 'number') return null
  const len = lengthIdx[`${q.subject}|${q.roc_year}|${q.session || ''}`]
  const fmt = pickFormat(len)
  const rset = rules[fmt]
  for (const [to, tag, name, stage_id] of rset) {
    if (n <= to) return { tag, name, stage_id }
  }
  // Overflow (e.g. 80-题 paper with Q81-100 stragglers): bucket into last range.
  const last = rset[rset.length - 1]
  return { tag: last[1], name: last[2], stage_id: last[3] }
}

function main() {
  const data = JSON.parse(fs.readFileSync(QFILE, 'utf8'))
  const arr = Array.isArray(data) ? data : data.questions
  const lengthIdx = buildLengthIndex(arr)
  const stats = {}
  let unmapped = 0
  for (const q of arr) {
    const r = classify(q, lengthIdx)
    if (!r) { unmapped++; continue }
    q.subject_tag  = r.tag
    q.subject_name = r.name
    q.stage_id     = r.stage_id
    stats[r.tag] = (stats[r.tag] || 0) + 1
  }
  console.log('sub-subject counts:')
  for (const [t, c] of Object.entries(stats).sort((a,b)=>b[1]-a[1])) {
    console.log(' ', t.padEnd(22), c)
  }
  console.log('unmapped:', unmapped)
  if (process.argv.includes('--dry-run')) { console.log('\n(dry-run, no write)'); return }
  const tmp = QFILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, QFILE)
  console.log('\nwrote', QFILE)
}

main()
