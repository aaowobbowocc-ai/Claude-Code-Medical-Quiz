#!/usr/bin/env node
/**
 * 修「一行裡有兩個選項被切錯」的題。
 *
 * 考選部 PDF 的選項有時會擠在同一個 text run：
 *   「Ⓐ上、下顎第三大臼齒Ⓑ下顎第二小臼齒」
 * 舊的解析法只看開頭第一個標記，於是切成
 *   A="上、"  B="下顎第三大臼齒下顎第二小臼齒"
 * 後面的選項全部錯位。嚴重的會變成
 *   A="一律依照標準化程序" B="施測" C="不要多問，簡略記載，" D="以節省時間"
 * ——真正的四個選項只剩兩個，使用者根本選不到正解。
 *
 * 根因已在 fill-civil-gaps.js 的 paperQuestions() 修好（依標記逐段切），
 * 這支負責把既有資料重抓一遍。
 *
 * 判準：選項以「、，（(」結尾＝被切在半路。只重建原卷解析得出四個
 * 乾淨選項的題，答案一律以座標配對的標準答案卷為準。
 *
 *   node scripts/repair-split-run-options.js               # dry-run
 *   node scripts/repair-split-run-options.js --apply
 *   node scripts/repair-split-run-options.js --exam dental-tech
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { resolvePaper } = require('./lib/moex-paper-resolve')
const { paperQuestions } = require('./fill-civil-gaps')
const { sheetMap } = require('./lib/moex-answer-geo')
const { optionKey } = require('./lib/moex-normalize')
const { atomicWriteJson } = require('./lib/atomic-write')

const ROOT = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const arg = k => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null }
const ONLY = arg('--exam')

// 切在半路的痕跡。中文選項不會以頓號或逗號結尾。
const CUT = /[、，,（(]$/

const examOf = f => f === 'questions.json' ? 'doctor1' : f.replace(/^questions-|\.json$/g, '')

;(async () => {
  const files = fs.readdirSync(ROOT).filter(f => /^questions.*\.json$/.test(f))
  // 先掃出受影響的題，依「同一卷」分組，每卷只抓一次 PDF
  const groups = new Map()
  const data = {}
  for (const f of files) {
    const exam = examOf(f)
    if (ONLY && exam !== ONLY) continue
    let j
    try { j = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')) } catch { continue }
    const arr = j.questions || j
    if (!Array.isArray(arr)) continue
    data[f] = j
    for (const q of arr) {
      if (q.option_images) continue
      const vals = Object.values(q.options || {}).map(t => String(t || '').trim())
      if (vals.length < 4 || !vals.some(t => CUT.test(t))) continue
      const key = [f, q.exam_code, q.subject].join('\u0000')
      if (!groups.has(key)) groups.set(key, { f, exam, code: String(q.exam_code), subject: q.subject, year: String(q.roc_year), items: [] })
      groups.get(key).items.push(q)
    }
  }
  const total = [...groups.values()].reduce((a, g) => a + g.items.length, 0)
  console.log(`受影響 ${total} 題，分布在 ${groups.size} 卷\n`)

  let fixed = 0, skipped = 0, noPaper = 0
  const skipReasons = {}
  const samples = []
  for (const g of groups.values()) {
    const arr = data[g.f].questions || data[g.f]
    const all = arr.filter(q => String(q.exam_code) === g.code && q.subject === g.subject)
    let p = null
    try { p = await resolvePaper({ exam: g.exam, code: g.code, subject: g.subject, year: g.year, items: all }) } catch {}
    if (!p) { noPaper += g.items.length; console.log(`  ✗ ${g.exam} ${g.year} ${g.subject}: 對不到官方卷（${g.items.length} 題）`); continue }
    let parsed, ans
    try {
      parsed = await paperQuestions(g.code, p.c, p.s)
      ans = (await sheetMap(g.code, p.c, p.s, Math.max(80, all.length))).map
    } catch (e) { noPaper += g.items.length; console.log(`  ✗ ${g.exam} ${g.year} ${g.subject}: ${e.message.slice(0, 40)}`); continue }

    let n = 0
    for (const q of g.items) {
      const o = parsed.get(+q.number)
      const bump = r => { skipReasons[r] = (skipReasons[r] || 0) + 1; skipped++ }
      if (!o) { bump('原卷解析不到該題號'); continue }
      const opts = {}
      for (const k of ['A', 'B', 'C', 'D']) opts[k] = String(o.options[k] || '').trim()
      const vals = Object.values(opts)
      if (vals.some(t => !t)) { bump('原卷解析出來還是缺選項'); continue }
      if (new Set(vals.map(optionKey)).size !== 4) { bump('原卷解析出來選項重複'); continue }
      if (vals.some(t => CUT.test(t))) { bump('原卷解析出來仍切在半路'); continue }
      const a = ans.get(+q.number)
      if (!a || !/^[ABCD]$/.test(String(a))) { bump('答案卷取不到'); continue }

      const before = ['A', 'B', 'C', 'D'].map(k => String(q.options[k] || '')).join(' | ')
      if (samples.length < 8) {
        samples.push({ g, q, before, after: vals.join(' | '), oldAns: q.answer, newAns: String(a) })
      }
      if (APPLY) {
        q.options = opts
        const stem = String(o.stem || '').replace(/^[\s.．、]+/, '')
        if (stem.length >= 8) q.question = stem
        q.answer = String(a)
      }
      n++; fixed++
    }
    if (n) console.log(`  ${g.exam} ${g.year} ${g.subject}: 重建 ${n}/${g.items.length} 題`)
  }

  console.log('\n─── 抽樣（前 8 筆）───')
  for (const s of samples) {
    console.log(`\n${s.g.exam} ${s.g.year} ${s.g.subject} #${s.q.number}  答${s.oldAns}→${s.newAns}`)
    console.log(`  舊: ${s.before.slice(0, 150)}`)
    console.log(`  新: ${s.after.slice(0, 150)}`)
  }

  console.log(`\n重建 ${fixed} 題；跳過 ${skipped}（${JSON.stringify(skipReasons)}）；對不到卷 ${noPaper}${APPLY ? '' : '（dry-run）'}`)
  if (APPLY) {
    for (const [f, j] of Object.entries(data)) {
      const arr = j.questions || j
      if (j.total !== undefined) j.total = arr.length
      atomicWriteJson(path.join(ROOT, f), j)
    }
    console.log('✅ 已寫回')
  }
})().catch(e => { console.error(e.stack); process.exit(1) })
