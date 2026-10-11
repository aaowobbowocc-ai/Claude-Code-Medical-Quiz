#!/usr/bin/env node
/**
 * 把「答案與標準答案卷不同、而且選項也對不起來」那批分三堆，產出可人工覆核的對照表。
 * **只讀不寫。**
 *
 * 分堆判準與 repair-answer-option-mismatch.js 完全一致，所以這份表就是
 * 「按下 --apply 會發生什麼」的預覽：
 *   A 只改答案    — 四個選項逐位的字元集合相同（內容一樣，只是 PDF 把數字丟到尾巴）
 *   B 用原卷重建  — 原卷四個選項乾淨，而且我們的確實是壞的
 *   C 兩邊都壞    — 不動
 *   ✓ 已一致      — 前一輪 repair 已經處理掉
 *
 * 輸出 _tmp/answer-option-mismatch-review.json（給產表用）
 *
 *   node scripts/report-answer-option-mismatch.js
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { resolvePaper } = require('./lib/moex-paper-resolve')
const { paperQuestions } = require('./fill-civil-gaps')
const { sheetMap } = require('./lib/moex-answer-geo')

const BK = path.join(__dirname, '..')
const SRC = path.join(BK, '_tmp', 'answer-diff-option-mismatch.json')
const CUT = /[、，,（(]$/
const FILE = e => e === 'doctor1' ? 'questions.json' : `questions-${e}.json`
const norm = t => String(t || '').normalize('NFKC').replace(/[\s　（）()，,、。．·－-]/g, '').toLowerCase()
const sortedChars = t => [...norm(t)].sort().join('')

;(async () => {
  const rows = JSON.parse(fs.readFileSync(SRC, 'utf8'))
  const groups = new Map()
  for (const r of rows) {
    const k = [r.exam, r.code, r.subject].join('\u0000')
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }

  const cache = {}
  const out = []
  const tally = { A: 0, B: 0, C: 0, done: 0, unresolved: 0 }
  for (const [k, items] of groups) {
    const [exam, code, subject] = k.split('\u0000')
    const f = FILE(exam)
    const data = cache[f] || (cache[f] = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')))
    const arr = data.questions || data
    const all = arr.filter(q => String(q.exam_code) === String(code) && q.subject === subject)
    let p = null
    try { p = await resolvePaper({ exam, code: String(code), subject, year: String(all[0]?.roc_year), items: all }) } catch {}
    let parsed = null, ans = null
    if (p) {
      try {
        parsed = await paperQuestions(String(code), p.c, p.s)
        ans = (await sheetMap(String(code), p.c, p.s, Math.max(80, all.length))).map
      } catch { parsed = null }
    }
    for (const r of items) {
      const q = all.find(x => +x.number === +r.n)
      const o = parsed && parsed.get(+r.n)
      const off = ans && ans.get(+r.n)
      const base = { exam, code, subject, n: r.n, year: q?.roc_year, stem: String(q?.question || r.stem).replace(/\s+/g, ' ') }
      if (!q || !o || !off || !/^[ABCD]$/.test(String(off))) {
        tally.unresolved++
        out.push({ ...base, bucket: 'unresolved', ours: q?.answer, off: off || null,
          ourOpts: q ? ['A','B','C','D'].map(x => String(q.options[x] || '')) : r.ourOpts, offOpts: o ? ['A','B','C','D'].map(x => String(o.options[x] || '')) : r.offOpts })
        continue
      }
      const ourOpts = ['A','B','C','D'].map(x => String(q.options[x] || ''))
      const offOpts = ['A','B','C','D'].map(x => String(o.options[x] || ''))
      const rec = { ...base, ours: String(q.answer), off: String(off), ourOpts, offOpts, offStem: String(o.stem || '').replace(/\s+/g, ' ') }

      if (String(q.answer) === String(off)) { tally.done++; out.push({ ...rec, bucket: 'done' }); continue }
      if ([0,1,2,3].every(i => norm(ourOpts[i]) && sortedChars(ourOpts[i]) === sortedChars(offOpts[i]))) {
        tally.A++; out.push({ ...rec, bucket: 'A' }); continue
      }
      const offClean = offOpts.every(t => t.trim()) && new Set(offOpts.map(norm)).size === 4 && !offOpts.some(t => CUT.test(t.trim()))
      const splitWrong = offOpts.some(off2 => {
        const o2 = norm(off2)
        if (o2.length < 12) return false
        return ourOpts.filter(t => norm(t).length >= 4 && o2.includes(norm(t))).length >= 2
      })
      const oursBroken = splitWrong || ourOpts.some(t => !t.trim())
        || new Set(ourOpts.map(norm)).size !== 4 || ourOpts.some(t => CUT.test(t.trim()))
      if (offClean && oursBroken) { tally.B++; out.push({ ...rec, bucket: 'B', splitWrong }); continue }
      tally.C++
      out.push({ ...rec, bucket: 'C', offClean, oursBroken })
    }
  }

  const dest = path.join(BK, '_tmp', 'answer-option-mismatch-review.json')
  fs.writeFileSync(dest, JSON.stringify(out, null, 1))
  console.log(`\nA 只改答案 ${tally.A}｜B 用原卷重建 ${tally.B}｜C 兩邊都壞 ${tally.C}｜✓ 已一致 ${tally.done}｜對不到卷 ${tally.unresolved}`)
  console.log(`📄 ${dest}`)
})().catch(e => { console.error(e.stack); process.exit(1) })
