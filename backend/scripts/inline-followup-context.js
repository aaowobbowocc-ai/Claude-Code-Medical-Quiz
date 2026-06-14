#!/usr/bin/env node
/**
 * 「承上題」題組自足化：把題組根題（含病例/情境的非承上題）的題幹，併入每個
 * 承上題的題幹，讓它在隨機練習單獨出現時也能作答。零成本純文字。
 *
 * 規則：承上題 #N → 同卷(exam_code+subject_tag)往回找最近「非承上題」根題 #M，
 * 把 #M 題幹當題組情境前置。已含「題組情境」者跳過(冪等)。
 * 用法：node scripts/inline-followup-context.js <questions-file> [--apply]
 */
const fs = require('fs')
const FILE = process.argv[2]
const APPLY = process.argv.includes('--apply')
if (!FILE) { console.error('需指定題庫檔'); process.exit(1) }

const MARK = '【題組情境】'
const isFollow = s => /^\s*承上題?[，,、\s]/.test(s || '')
const alreadyDone = s => (s || '').includes(MARK)

const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
const questions = Array.isArray(raw) ? raw : raw.questions

// 以 (exam_code|subject_tag) 分組，依 number 排序，建立查找
const groups = {}
for (const q of questions) {
  const k = `${q.exam_code}|${q.subject_tag || ''}`
  ;(groups[k] = groups[k] || []).push(q)
}
for (const k in groups) groups[k].sort((a, b) => (a.number || 0) - (b.number || 0))

let fixed = 0, noRoot = 0, skipped = 0
const samples = []
for (const k in groups) {
  const arr = groups[k]
  for (let i = 0; i < arr.length; i++) {
    const q = arr[i]
    if (!isFollow(q.question)) continue
    if (alreadyDone(q.question)) { skipped++; continue }
    // 往回找最近非承上題根題（number 連續遞減）
    let root = null
    for (let j = i - 1; j >= 0; j--) {
      if (arr[j].number !== arr[j + 1].number - 1) break // number 不連續→不同題組
      if (!isFollow(arr[j].question)) { root = arr[j]; break }
    }
    if (!root) { noRoot++; continue }
    const ctx = (root.question || '').trim()
    if (!ctx) { noRoot++; continue }
    const cur = (q.question || '').trim()
    const merged = `${MARK}${ctx}\n\n${cur}`
    // 根題有圖、承上題沒圖 → 複製圖過來，讓承上題自足（情境圖如顯微鏡/抹片）
    const copyImg = Array.isArray(root.images) && root.images.length && !(Array.isArray(q.images) && q.images.length)
    if (samples.length < 6) samples.push(`${q.id} #${q.number} ← 根#${root.number}${copyImg ? ' (+圖)' : ''}\n   ${merged.slice(0, 100)}...`)
    if (APPLY) {
      q.question = merged
      if (copyImg) q.images = [...root.images]
    }
    fixed++
  }
}

console.log(`承上題自足化：可併 ${fixed}，無根題 ${noRoot}，已處理過 ${skipped}`)
console.log('\n--- 範例 ---')
samples.forEach(s => console.log(s))
if (APPLY) {
  fs.writeFileSync(FILE, JSON.stringify(raw, null, 2))
  console.log(`\n✅ 已寫入 ${FILE}`)
} else {
  console.log('\n(dry-run，未寫檔；加 --apply 套用)')
}
