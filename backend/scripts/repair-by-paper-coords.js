#!/usr/bin/env node
/**
 * 用**指定的卷別座標**重建壞掉的選項。
 *
 * repair-split-run-options.js 靠 resolvePaper 自動對卷，但有些考試對不到：
 *   - 鐵路特考：科目名是「運輸學大意」，題庫存的是「鐵路運輸學大意」
 *   - 關務「國文（測驗）」：官方卷名是「國文（作文與測驗）」
 * 這支改成直接吃 (exam_code → c/s) 的對照表，其餘流程一樣：
 * 原卷解析 → 四個選項都乾淨才換 → 答案一律以座標配對的標準答案卷為準。
 *
 *   node scripts/repair-by-paper-coords.js            # dry-run
 *   node scripts/repair-by-paper-coords.js --apply
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { paperQuestions } = require('./fill-civil-gaps')
const { sheetMap } = require('./lib/moex-answer-geo')
const { optionKey } = require('./lib/moex-normalize')
const { atomicWriteJson } = require('./lib/atomic-write')

const ROOT = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const CUT = /[、，,（(]$/

// 鐵路的 c/s 在 _railway-map.json 裡，直接讀出來組表
const railway = JSON.parse(fs.readFileSync(path.join(__dirname, '_railway-map.json'), 'utf8'))
const TARGETS = []
for (const [year, e] of Object.entries(railway)) {
  for (const [key, file] of [['transport', 'questions-railway-transport.json'],
                             ['admin', 'questions-railway-admin.json']]) {
    const g = e[key]
    if (!g) continue
    // ⚠️ 一定要連「科目」一起對。只用 exam_code 過濾的話，同場次別科的題會被
    //    改成這一科的內容——第一版就把鐵路 103070「公民與英文」#46 的英文閱讀題
    //    換成了「事務管理大意」的採購題，答案還從 C 變成 A。
    for (const [s, name] of Object.entries(g.subjects || {})) {
      TARGETS.push({ file, code: String(e.sessionCode), c: g.c, s, expect: 50, subject: name })
    }
  }
}
// 關務「國文（測驗）」：c=101 s=0101（見 scrape-customs.js 的 SUBJECTS）
for (const code of ['109050', '110050', '111050', '112050', '108050']) {
  TARGETS.push({ file: 'questions-customs.json', code, c: '101', s: '0101', expect: 10, subject: '國文' })
}

/** 題庫的科目名與官方卷名不會一字不差，取關鍵詞比對。 */
function sameSubject(mine, official) {
  const key = t => String(t).replace(/[\s（）()「」]|大意|概要|測驗|包括.*$/g, '')
  const a = key(mine), b = key(official)
  return a.includes(b) || b.includes(a)
}

;(async () => {
  const cache = {}
  let fixed = 0, skipped = 0
  const reasons = {}
  const samples = []
  for (const t of TARGETS) {
    const p = path.join(ROOT, t.file)
    if (!fs.existsSync(p)) continue
    const j = cache[t.file] || (cache[t.file] = JSON.parse(fs.readFileSync(p, 'utf8')))
    const arr = j.questions || j
    const broken = arr.filter(q => String(q.exam_code) === t.code && !q.option_images &&
      (!t.subject || sameSubject(q.subject, t.subject)) &&
      Object.values(q.options || {}).some(v => CUT.test(String(v || '').trim())))
    if (!broken.length) continue

    let parsed, ans
    try {
      parsed = await paperQuestions(t.code, t.c, t.s)
      ans = (await sheetMap(t.code, t.c, t.s, t.expect)).map
    } catch (e) { console.log(`  ✗ ${t.file} ${t.code}: ${e.message.slice(0, 40)}`); continue }

    let n = 0
    for (const q of broken) {
      const o = parsed.get(+q.number)
      const bump = r => { reasons[r] = (reasons[r] || 0) + 1; skipped++ }
      if (!o) { bump('原卷解析不到該題號'); continue }
      const opts = {}
      for (const k of ['A', 'B', 'C', 'D']) opts[k] = String(o.options[k] || '').trim()
      const vals = Object.values(opts)
      if (vals.some(v => !v)) { bump('原卷仍缺選項'); continue }
      if (new Set(vals.map(optionKey)).size !== 4) { bump('原卷選項重複'); continue }
      if (vals.some(v => CUT.test(v))) { bump('原卷仍切在半路'); continue }
      const a = ans.get(+q.number)
      if (!a || !/^[ABCD]$/.test(String(a))) { bump('答案卷取不到'); continue }

      if (samples.length < 6) samples.push({
        t, q, before: ['A', 'B', 'C', 'D'].map(k => String(q.options[k] || '')).join(' | '),
        after: vals.join(' | '), oldAns: q.answer, newAns: String(a),
      })
      if (APPLY) {
        q.options = opts
        const stem = String(o.stem || '').replace(/^[\s.．、]+/, '')
        if (stem.length >= 8) q.question = stem
        q.answer = String(a)
      }
      n++; fixed++
    }
    if (n) console.log(`  ${t.file.replace(/questions-|\.json/g, '')} ${t.code} (c${t.c} s${t.s}): 重建 ${n}/${broken.length}`)
  }

  for (const s of samples) {
    console.log(`\n${s.t.file.replace(/questions-|\.json/g, '')} ${s.t.code} #${s.q.number}  答${s.oldAns}→${s.newAns}`)
    console.log(`  舊: ${s.before.slice(0, 130)}`)
    console.log(`  新: ${s.after.slice(0, 130)}`)
  }
  console.log(`\n重建 ${fixed} 題；跳過 ${skipped}（${JSON.stringify(reasons)}）${APPLY ? '' : '（dry-run）'}`)
  if (APPLY) {
    for (const [f, j] of Object.entries(cache)) {
      const arr = j.questions || j
      if (j.total !== undefined) j.total = arr.length
      atomicWriteJson(path.join(ROOT, f), j)
    }
    console.log('✅ 已寫回')
  }
})().catch(e => { console.error(e.stack); process.exit(1) })
