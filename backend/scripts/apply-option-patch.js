#!/usr/bin/env node
/**
 * 套用一份人工核對過的選項修正表。
 *
 * 這批題（broken_options）的共同點是**原卷的文字層本來就取不到**：公式、音標、
 * 上下劃線符號用的是沒有 ToUnicode 的字型，或整張卷是掃描檔。任何解析器都救不了，
 * 只能把原卷那一段渲染成圖、人看過之後寫下來。所以修正內容是外部輸入，不是推算的。
 *
 * patch 的 key 是 `exam|exam_code|subject|number`。**subject 一定要帶**：
 * 同一場次不同科目會共用題號，只用 exam_code+number 會改到別科的題
 * （見 [[project_cross_subject_overwrite]]）。
 *
 *   node scripts/apply-option-patch.js _tmp/patch.json          # 新舊並排
 *   node scripts/apply-option-patch.js _tmp/patch.json --apply
 */
const fs = require('fs')
const path = require('path')
const { atomicWriteJson } = require('./lib/atomic-write')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const PATCH = process.argv.find(a => !a.startsWith('--') && /\.json$/.test(a) && !/apply-option-patch/.test(a))
if (!PATCH) { console.error('用法: node scripts/apply-option-patch.js <patch.json> [--apply]'); process.exit(1) }

const file = e => path.join(BK, e === 'doctor1' ? 'questions.json' : 'questions-' + e + '.json')
const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()

const patch = JSON.parse(fs.readFileSync(PATCH, 'utf8'))
const byExam = new Map()
for (const p of patch) {
  const exam = p.k.split('|')[0]
  if (!byExam.has(exam)) byExam.set(exam, [])
  byExam.get(exam).push(p)
}

let changed = 0, skipped = 0
for (const [exam, items] of byExam) {
  const fp = file(exam)
  const j = JSON.parse(fs.readFileSync(fp, 'utf8'))
  const arr = Array.isArray(j) ? j : j.questions
  let dirty = false

  for (const p of items) {
    const [, code, subject, n] = p.k.split('|')
    const hits = arr.filter(q => String(q.exam_code) === code && String(q.subject) === subject && Number(q.number) === Number(n))
    if (hits.length !== 1) { console.log('✗ ' + p.k + ' 對到 ' + hits.length + ' 筆，跳過'); skipped++; continue }
    const q = hits[0]

    console.log('\n── ' + p.k + '   答案 ' + (q.answer || '?'))
    console.log('   · ' + p.why)
    if (p.question !== undefined && norm(p.question) !== norm(q.question)) {
      console.log('   題幹 舊 ' + JSON.stringify(norm(q.question).slice(0, 78)))
      console.log('        新 ' + JSON.stringify(norm(p.question).slice(0, 78)))
    }
    if (p.options) for (const K of ['A', 'B', 'C', 'D']) {
      const a = norm((q.options || {})[K]), b = norm(p.options[K])
      if (a === b) { console.log('   ' + K + ' 　 ' + JSON.stringify(a.slice(0, 72))); continue }
      console.log('   ' + K + ' 舊 ' + JSON.stringify(a.slice(0, 72)))
      console.log('     新 ' + JSON.stringify(b.slice(0, 72)))
    }
    const flagTo = p.flag || (p.clear ? '(清掉)' : null)
    if (flagTo) console.log('   旗標 ' + (q.incomplete || '無') + ' → ' + flagTo)
    if (p.dupsrc) console.log('   標記 duplicate_in_source（原卷就重複，逐字還原）')

    if (APPLY) {
      if (p.question !== undefined) q.question = p.question
      if (p.options) q.options = { ...q.options, ...p.options }
      if (p.flag) q.incomplete = p.flag
      else if (p.clear) delete q.incomplete
      if (p.dupsrc) q.duplicate_in_source = true
      dirty = true
    }
    changed++
  }
  if (APPLY && dirty) atomicWriteJson(fp, j)
}

console.log('\n' + (APPLY ? '已套用 ' : '可套用 ') + changed + ' 題' + (skipped ? '｜跳過 ' + skipped : ''))
if (!APPLY) console.log('(試跑；加 --apply 才寫入)')
