#!/usr/bin/env node
/**
 * 更正答案：只比「標準答案卷指到的那一格」的選項文字。
 *
 * `fix-answers-by-option-text.js` 要求**四個選項逐位相同**才敢改，
 * 所以原卷有任何一格被污染（數字跑位、黏到下一題）整題就跳過，
 * 留下 65 題「答案不同而且選項對不起來」。
 *
 * 但要判答案字母，其實只需要知道「官方答案那一段文字，在我們的四格裡是哪一格」。
 * 其他三格壞不壞不影響這個判斷。三種比法，命中必須**唯一**：
 *   1. 正規化後完全相同
 *   2. 前綴關係（某一邊被截斷），短的那段至少 10 字且占長的一半以上
 *   3. 字元集合相同（原卷把數字丟到尾巴：`3,000 Hz` → `,000 Hz3`）
 *
 * 四道防呆：
 *   - **我們的答案是多字母（`C,D`）就不動**。那是考選部更正「兩個選項均給分」
 *     的爭議題，塌成單一字母會把「均給分」弄丟（實測 doctor2 有 4 題）。
 *   - **題幹對不上就不動**。原卷解析到別題甚至別卷時，這個比對根本不成立
 *     （實測 23 題，叢集在 police 107070、dental2 104090 卷一）。
 *   - **整卷答案對齊率 < 70% 就整卷不動**。對齊率低代表答案卷本身可能位移，
 *     這時官方字母不可信（比字母會假警報）。
 *   - 命中不唯一、或答案那格文字太短（< 6 字，多半是數字或圖）就不動。
 *
 *   node scripts/fix-answers-by-answer-option.js            # dry-run
 *   node scripts/fix-answers-by-answer-option.js --apply
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
const L = ['A', 'B', 'C', 'D']
const FILE = e => e === 'doctor1' ? 'questions.json' : `questions-${e}.json`
const norm = t => String(t || '').normalize('NFKC').replace(/[\s　（）()，,、。．·－-]/g, '').toLowerCase()
const sortedChars = t => [...norm(t)].sort().join('')
const MIN_ALIGN = 0.70

/** 題幹相似度＝共同字元佔比。原卷抓到別題時會掉到 0.1 以下。 */
function stemSim(a, b) {
  const A = new Set(norm(a)), B = new Set(norm(b))
  if (!A.size || !B.size) return 0
  let c = 0
  for (const x of A) if (B.has(x)) c++
  return c / Math.max(A.size, B.size)
}

/** 官方答案那段文字落在我們的哪一格；找不到或不唯一回 null。 */
function locate(offText, ourOpts) {
  const want = norm(offText)
  if (want.length < 6) return null
  for (const test of [
    t => norm(t) === want,
    t => {
      const a = norm(t)
      if (a.length < 6) return false
      const [short, long] = a.length < want.length ? [a, want] : [want, a]
      return long.startsWith(short) && short.length >= Math.max(10, long.length * 0.5)
    },
    t => norm(t).length >= 6 && sortedChars(t) === sortedChars(offText),
  ]) {
    const hits = ourOpts.map((t, i) => test(t) ? L[i] : null).filter(Boolean)
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) return null
  }
  return null
}

;(async () => {
  if (!fs.existsSync(SRC)) { console.error('缺 ' + SRC + '，先跑 fix-answers-by-option-text.js'); process.exit(1) }
  const groups = new Map()
  for (const r of JSON.parse(fs.readFileSync(SRC, 'utf8'))) {
    const k = [r.exam, r.code, r.subject].join('\u0000')
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }

  const cache = {}
  const skip = {}
  const bump = r => { skip[r] = (skip[r] || 0) + 1 }
  let changed = 0, already = 0
  for (const [k, items] of groups) {
    const [exam, code, subject] = k.split('\u0000')
    const f = FILE(exam)
    const data = cache[f] || (cache[f] = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')))
    const arr = data.questions || data
    const all = arr.filter(q => String(q.exam_code) === String(code) && q.subject === subject)
    let parsed = null, ans = null
    try {
      const p = await resolvePaper({ exam, code: String(code), subject, year: String(all[0]?.roc_year), items: all })
      parsed = await paperQuestions(String(code), p.c, p.s)
      ans = (await sheetMap(String(code), p.c, p.s, Math.max(80, all.length))).map
    } catch { bump('對不到卷或解析失敗'); continue }

    // 整卷對齊率：答案卷自己有沒有位移
    let hit = 0, tot = 0
    for (const q of all) {
      const off = ans.get(+q.number)
      if (!off || !/^[ABCD]$/.test(String(off))) continue
      tot++
      if (String(q.answer) === String(off)) hit++
    }
    const align = tot ? hit / tot : 0
    if (align < MIN_ALIGN) {
      console.log(`  ⊘ ${exam} ${code} ${subject.slice(0, 14)}：整卷對齊率僅 ${Math.round(align * 100)}%，答案卷可能位移，整卷不動`)
      bump('整卷對齊率過低')
      continue
    }

    for (const r of items) {
      const q = all.find(x => +x.number === +r.n)
      const o = parsed.get(+r.n)
      const off = ans.get(+r.n)
      if (!q || !o || !off || !/^[ABCD]$/.test(String(off))) { bump('重解不到該題'); continue }
      if (String(q.answer) === String(off)) { already++; continue }
      if (String(q.answer).includes(',')) { bump('爭議題多字母，保留'); continue }
      const sim = stemSim(q.question, o.stem)
      if (sim < 0.5) { bump('原卷抓到別題，比對無效'); continue }

      const ourOpts = L.map(x => String(q.options[x] || ''))
      const offOpts = L.map(x => String(o.options[x] || ''))

      // 四格裡有三格**逐位完全相同** → 選項排序已確認與原卷一致，官方字母可以直接採用。
      // 第四格被原卷污染而已（nursing 103100 #65 的 D 被黏上下一題的題幹，
      // 前綴比只有 40% 過不了 locate()，但 A/B/C 三格一字不差，排序沒有疑問）。
      // 三格對上就不可能是排列：那三個選項已經被佔掉，第四格只能是同一個選項。
      const exactPos = L.filter((x, i) => norm(ourOpts[i]) && norm(ourOpts[i]) === norm(offOpts[i])).length
      const should = exactPos >= 3 ? String(off) : locate(offOpts[L.indexOf(String(off))], ourOpts)
      if (!should) { bump('答案那格文字對不到唯一的格'); continue }
      if (should === String(q.answer)) { already++; continue }

      console.log(`\n${exam} ${code} ${subject.slice(0, 14)} #${r.n}  ${q.answer} → ${should}  (答案卷 ${off}，整卷對齊 ${Math.round(align * 100)}%)`)
      console.log(`  題幹: ${String(q.question).replace(/\s+/g, ' ').slice(0, 64)}`)
      console.log(`  官方答案那格: ${String(o.options[String(off)]).replace(/\s+/g, ' ').slice(0, 72)}`)
      console.log(`  我們的 ${should}:      ${String(q.options[should]).replace(/\s+/g, ' ').slice(0, 72)}`)
      if (APPLY) q.answer = should
      changed++
    }
  }

  console.log(`\n更正 ${changed} 題｜本來就對 ${already} 題${APPLY ? '' : '（dry-run）'}`)
  console.log('跳過：' + JSON.stringify(skip))
  if (APPLY && changed) {
    for (const [f, data] of Object.entries(cache)) atomicWriteJson(path.join(BK, f), data)
    console.log('✅ 已寫回')
  }
})().catch(e => { console.error(e.stack); process.exit(1) })
