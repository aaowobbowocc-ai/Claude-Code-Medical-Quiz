#!/usr/bin/env node
/**
 * 修「題目都對、只有科目標籤掛錯」的卷。
 *
 * 物理治療師 106~109 年共 7 場、42 卷是這種：同一場次裡六個科目兩兩互換
 * （物理治療學概論 ↔ 骨科疾病物理治療學、物理治療基礎學 ↔ 神經疾病物理治療學…）。
 * 題幹、選項、答案、題號全部正確，只有 subject 貼錯——所以使用者選「骨科」
 * 練到的是「概論」的題。
 *
 * 跟 fix-dental2-paper-split 的差別：那個是題目被重新切過，題號要重算；
 * 這個題號完全對齊，只要換標籤，風險低得多。
 *
 * 安全機制（三個都要過才動手）：
 *   1. 每個科目都要找得到「同題號命中率 ≥ MIN」的官方卷
 *   2. 科目對應必須是 1:1 雙射（不能兩個科目搶同一張卷）
 *   3. 至少有一個科目真的需要換（否則整場跳過，不做白工）
 *
 * 用法：
 *   node scripts/fix-subject-swap.js --exam pt --code 106020
 *   node scripts/fix-subject-swap.js --exam pt --all --apply
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { probeCodes, nameCandidates, fetchSheet } = require('./lib/moex-paper-resolve')
const { pdfStems } = require('./lib/moex-pdf-parse')
const { skeleton, sameName } = require('./lib/moex-normalize')
const { warnZero, summary } = require('./lib/coverage-guard')

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d }
const EXAM = arg('--exam')
const CODE = arg('--code')
const ALL = process.argv.includes('--all')
const APPLY = process.argv.includes('--apply')
const MIN = +arg('--min', '0.7')
if (!EXAM || (!CODE && !ALL)) { console.error('需要 --exam 以及 --code 或 --all'); process.exit(1) }
const FILE = path.join(__dirname, '..', EXAM === 'doctor1' ? 'questions.json' : `questions-${EXAM}.json`)

const key = q => skeleton(q.question).replace(/^【題組情境】/, '').slice(0, 18)

async function fixSession(arr, code) {
  const rows = arr.filter(q => String(q.exam_code) === code)
  const subjects = [...new Set(rows.map(q => q.subject).filter(Boolean))]
  if (subjects.length < 2) return 0

  // 該場次所有可能相關的官方卷（用我們的科目名去撈候選，聯集起來）
  const codes = probeCodes(code, code.slice(0, 3))
  const papers = new Map()
  for (const sub of subjects) {
    const { list } = nameCandidates(EXAM, sub, codes)
    for (const c of list) {
      const k = `${c.c}|${c.s}`
      if (!papers.has(k)) papers.set(k, { ...c, stems: null })
    }
  }
  for (const p of papers.values()) {
    try { const b = await fetchSheet('Q', code, p.c, p.s); if (b) p.stems = await pdfStems(b) } catch {}
  }
  const usable = [...papers.values()].filter(p => p.stems && p.stems.size)
  if (usable.length < subjects.length) { console.log(`  ${code}: 只取到 ${usable.length}/${subjects.length} 張官方卷，跳過`); return 0 }

  // 每個科目 → 同題號命中率最高的官方卷
  const best = new Map()
  for (const sub of subjects) {
    const items = rows.filter(q => q.subject === sub)
    let top = null
    for (const p of usable) {
      let hit = 0, n = 0
      for (const q of items) {
        const s = key(q)
        if (s.length < 14) continue
        n++
        const own = p.stems.get(+q.number)
        if (own && own.includes(s)) hit++
      }
      const rate = n ? hit / n : 0
      if (!top || rate > top.rate) top = { p, rate }
    }
    if (!top || top.rate < MIN) { console.log(`  ${code}: 「${sub}」找不到命中率 ≥${MIN * 100}% 的卷（最高 ${top ? (top.rate * 100).toFixed(0) : 0}%），整場跳過`); return 0 }
    best.set(sub, top)
  }
  // 必須 1:1，不能兩個科目搶同一張卷
  const used = new Set([...best.values()].map(v => `${v.p.c}|${v.p.s}`))
  if (used.size !== subjects.length) { console.log(`  ${code}: 科目與官方卷不是一對一，整場跳過`); return 0 }

  // 官方卷 → 應該用的「我們的科目名」
  const officialToOurs = new Map()
  for (const p of usable) {
    const match = subjects.find(s => sameName(p.subject, s))
    if (match) officialToOurs.set(`${p.c}|${p.s}`, match)
  }

  // 每個科目的標籤組（一個科目一組固定值，取第一筆即可）
  const tagOf = new Map()
  for (const sub of subjects) {
    const q = rows.find(x => x.subject === sub)
    tagOf.set(sub, { subject: sub, subject_tag: q.subject_tag, subject_name: q.subject_name })
  }

  let changed = 0
  const plan = []
  for (const sub of subjects) {
    const realName = officialToOurs.get(`${best.get(sub).p.c}|${best.get(sub).p.s}`)
    if (!realName || realName === sub) continue
    plan.push({ from: sub, to: realName, n: rows.filter(q => q.subject === sub).length })
  }
  if (!plan.length) return 0

  for (const p of plan) {
    const t = tagOf.get(p.to)
    console.log(`  ${code}: 「${p.from}」→「${p.to}」 ${p.n} 題`)
    if (APPLY) {
      for (const q of rows) {
        if (q.subject !== p.from) continue
        q.__newTag = t     // 先暫存，全部算完再一次套用，免得改到一半互相污染
      }
    }
    changed += p.n
  }
  if (APPLY) {
    for (const q of rows) {
      if (!q.__newTag) continue
      q.subject = q.__newTag.subject
      q.subject_tag = q.__newTag.subject_tag
      q.subject_name = q.__newTag.subject_name
      delete q.__newTag
    }
  }
  return changed
}

;(async () => {
  const j = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  const arr = j.questions || j
  let codes = [CODE]
  if (ALL) {
    // 用 alignment 體檢的結果決定要處理哪些場次
    const p = path.join(__dirname, '..', '_tmp', `alignment-${EXAM}.json`)
    if (!fs.existsSync(p)) { console.error(`找不到 ${path.basename(p)}，先跑 audit-paper-alignment.js --exam ${EXAM}`); process.exit(1) }
    codes = [...new Set(JSON.parse(fs.readFileSync(p, 'utf8')).broken.map(b => b.code))].sort()
    console.log(`依體檢結果處理 ${codes.length} 個場次：${codes.join(' ')}\n`)
  }

  let total = 0
  for (const c of codes) total += await fixSession(arr, c)
  console.log(`\n共 ${total} 題的科目標籤${APPLY ? '已修正' : '待修正（dry-run）'}`)
  warnZero(`${EXAM} 科目標籤修正`, total, '標籤本來就對，或命中率不足以判定')
  if (APPLY && total) {
    if (j.metadata) j.metadata.last_updated = new Date().toISOString()
    fs.writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n')
    console.log(`✅ 已寫回 ${path.basename(FILE)}`)
  }
  process.exitCode = summary()
})()
