#!/usr/bin/env node
/**
 * 處理 `fix-answers-by-option-text.js` 跳過的那批：
 * 「答案與標準答案卷不同，而且選項也對不起來」。
 *
 * 那批不能直接改答案——選項對不起來代表字母指的不是同一個選項，
 * 改了只會蓋掉症狀。分成三種處理：
 *
 *  A. **字序被打亂**：`3個月` vs `個月3`、`3-Flange Plug(層次式耳塞)` vs
 *     `-Flange Plug（層次式耳塞）3`。四個選項逐位的**字元集合**相同，
 *     代表內容其實一樣，只是 PDF 把數字丟到尾巴。→ 只改答案。
 *     （用字元集合比而不是去掉數字：`at 30` 與 `at 20` 的字元集合不同，
 *      才不會把真的不一樣的選項當成同一個。）
 *  B. **原卷四個選項乾淨**：我們的選項是碎的（題幹漏進來、被切兩半）。
 *     → 題幹、選項、答案整題以原卷為準重建。
 *  C. **兩邊都壞**：原卷解析出來也缺選項或切在半路。→ 不動，另案處理。
 *
 * 前置：node scripts/fix-answers-by-option-text.js   （產生 _tmp/answer-diff-option-mismatch.json）
 *
 *   node scripts/repair-answer-option-mismatch.js            # dry-run
 *   node scripts/repair-answer-option-mismatch.js --apply
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { resolvePaper } = require('./lib/moex-paper-resolve')
const { paperQuestions } = require('./fill-civil-gaps')
const { sheetMap } = require('./lib/moex-answer-geo')
const { atomicWriteJson } = require('./lib/atomic-write')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const SRC = path.join(BK, '_tmp', 'answer-diff-option-mismatch.json')
const CUT = /[、，,（(]$/
const FILE = e => e === 'doctor1' ? 'questions.json' : `questions-${e}.json`
const norm = t => String(t || '').normalize('NFKC').replace(/[\s　（）()，,、。．·－-]/g, '').toLowerCase()
const sortedChars = t => [...norm(t)].sort().join('')

;(async () => {
  if (!fs.existsSync(SRC)) { console.error('缺 ' + SRC + '，先跑 fix-answers-by-option-text.js'); process.exit(1) }
  const rows = JSON.parse(fs.readFileSync(SRC, 'utf8'))

  // 依卷分組，每卷只抓一次 PDF
  const groups = new Map()
  for (const r of rows) {
    const k = [r.exam, r.code, r.subject].join('\u0000')
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }

  const cache = {}
  let answerOnly = 0, rebuilt = 0, stuck = 0
  const samples = []
  for (const [k, items] of groups) {
    const [exam, code, subject] = k.split('\u0000')
    const f = FILE(exam)
    const data = cache[f] || (cache[f] = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')))
    const arr = data.questions || data
    const all = arr.filter(q => String(q.exam_code) === String(code) && q.subject === subject)
    let p = null
    try { p = await resolvePaper({ exam, code: String(code), subject, year: String(all[0]?.roc_year), items: all }) } catch {}
    if (!p) { stuck += items.length; continue }
    let parsed, ans
    try {
      parsed = await paperQuestions(String(code), p.c, p.s)
      ans = (await sheetMap(String(code), p.c, p.s, Math.max(80, all.length))).map
    } catch { stuck += items.length; continue }

    for (const r of items) {
      const q = all.find(x => +x.number === +r.n)
      const o = parsed.get(+r.n)
      const off = ans.get(+r.n)
      if (!q || !o || !off || !/^[ABCD]$/.test(String(off))) { stuck++; continue }
      const ourOpts = ['A', 'B', 'C', 'D'].map(x => String(q.options[x] || ''))
      const offOpts = ['A', 'B', 'C', 'D'].map(x => String(o.options[x] || ''))

      // A. 字元集合逐位相同 → 內容一樣，只是字序被打亂，改答案就好
      if ([0, 1, 2, 3].every(i => norm(ourOpts[i]) && sortedChars(ourOpts[i]) === sortedChars(offOpts[i]))) {
        if (samples.length < 6) samples.push({ kind: 'A', exam, code, n: r.n, from: q.answer, to: String(off), ourOpts, offOpts })
        if (APPLY) q.answer = String(off)
        answerOnly++
        continue
      }
      // B. 原卷四個選項乾淨**而且我們的確實是壞的** → 整題以原卷為準重建。
      //    ⚠️ 不能只因為「不一樣」就重建：audiologist 106110 #25 我們存的
      //    「3,000 Hz，音量會升高」是對的，原卷解析出來卻是「,000 Hz，音量會升高3」
      //    （數字被丟到尾巴）而且最後一個選項還黏了下一題的情境——重建反而變爛。
      const offClean = offOpts.every(t => t.trim()) && new Set(offOpts.map(norm)).size === 4
        && !offOpts.some(t => CUT.test(t.trim()))
      // 「我們的切法錯了」最可靠的訊號：**原卷的某一個選項，同時包含我們的兩個選項**
      // ——代表那一個選項在我們這邊被切成了兩格，後面全部跟著錯位。
      const splitWrong = offOpts.some(off => {
        const o2 = norm(off)
        if (o2.length < 12) return false
        return ourOpts.filter(t => norm(t).length >= 4 && o2.includes(norm(t))).length >= 2
      })
      const oursBroken = splitWrong
        || ourOpts.some(t => !t.trim())
        || new Set(ourOpts.map(norm)).size !== 4
        || ourOpts.some(t => CUT.test(t.trim()))
      if (offClean && oursBroken) {
        if (samples.length < 6) samples.push({ kind: 'B', exam, code, n: r.n, from: q.answer, to: String(off), ourOpts, offOpts, stem: String(o.stem) })
        if (APPLY) {
          q.options = { A: offOpts[0], B: offOpts[1], C: offOpts[2], D: offOpts[3] }
          const stem = String(o.stem || '').replace(/^[\s.．、]+/, '')
          if (stem.length >= 8) q.question = stem
          q.answer = String(off)
        }
        rebuilt++
        continue
      }
      stuck++
    }
  }

  for (const s of samples) {
    console.log(`\n[${s.kind}] ${s.exam} ${s.code} #${s.n}  答 ${s.from}→${s.to}`)
    console.log(`  舊: ${s.ourOpts.join(' | ').slice(0, 120)}`)
    console.log(`  新: ${(s.kind === 'A' ? s.ourOpts : s.offOpts).join(' | ').slice(0, 120)}`)
  }
  console.log(`\nA 只改答案 ${answerOnly}｜B 整題重建 ${rebuilt}｜C 兩邊都壞不動 ${stuck}${APPLY ? '' : '（dry-run）'}`)
  if (APPLY) {
    for (const [f, data] of Object.entries(cache)) atomicWriteJson(path.join(BK, f), data)
    console.log('✅ 已寫回')
  }
})().catch(e => { console.error(e.stack); process.exit(1) })
