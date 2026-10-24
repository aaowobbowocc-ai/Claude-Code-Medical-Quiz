#!/usr/bin/env node
/**
 * 修「題幹對得上、但選項文字在原卷裡根本找不到」的題。
 *
 *   tcm2 100140 #31  我們：《外臺祕要》長布海藻方 /《證治準繩》蘂蠲散
 *                    原卷：《外臺秘要》昆布海藻方 /《證治準繩》藻藥散
 *   tcm2 100140 #19  我們：蛇串瘡 / 琉璃疽 / 甲疽 / 瘰癧
 *                    原卷：蛇串瘡 / 抱頭火丹 / 大頭瘟 / 丹毒   ← B/C/D 整組是別題的
 *
 * 這批沒有「文字守恆」可以當保證（repair-stem-ate-option.js 用的那套），
 * 因為內容真的不同，不只是切點。所以改用另一個客觀判準：
 *
 *   **我們的選項在原卷全文裡找不到，而原卷解析出來的那個找得到** → 我們錯。
 *
 * 四道閘：
 *   1. 題幹要對得上（正規化後相同，或互為前綴）——確認是同一題
 *   2. 原卷解析出乾淨的四個選項（PUA/零寬當空、不含 ___、不含連續三組字母+數字）
 *   3. **每一個**不同的選項，我們的版本都要在原卷全文找不到
 *      （只要有一個找得到，就代表我們那版也在卷上，不敢斷定誰對）
 *   4. 答案一律取答案卷；多字母的爭議題保留原答案
 *
 * ⚠️ 原卷全文比對用 pdfText + 消除 run 重疊兩種抽法，`�` 當萬用字元
 *    （那些 PDF 字型沒有合法 ToUnicode 對應，見 project_broken_glyphs）。
 *
 *   node scripts/repair-options-not-in-paper.js --exam=tcm2        # dry-run
 *   node scripts/repair-options-not-in-paper.js --exam=tcm2 --apply
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { resolvePaper, fetchSheet, pdfText } = require('./lib/moex-paper-resolve')
const { pdfTextClean } = require('./lib/moex-run-overlap')
const { paperQuestions } = require('./fill-civil-gaps')
const { markerOptions } = require('./lib/moex-marker-options')
const { sheetMap } = require('./lib/moex-answer-geo')
const { skeleton } = require('./lib/moex-normalize')
const { atomicWriteJson } = require('./lib/atomic-write')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1]
const L = ['A', 'B', 'C', 'D']
const EXAM = f => f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '')
const SKIP = new Set(['gsat', 'ast', 'driver-car', 'driver-moto', 'post-indoor', 'post-outdoor',
  'railway-admin', 'railway-transport', 'state-finance', 'state-hr', 'state-it', 'state-mgmt',
  'teacher-elementary', 'teacher-kindergarten', 'teacher-secondary', 'teacher-special', 'teacher-special-gifted'])
const MIN_OPT = 6     // 太短的選項（「甲」「①②」）在全文一定找得到，判不出來

const bare = t => String(t).replace(/[-​-‏﻿\s　]/g, '')

/**
 * 原卷文字層的**排版與字形**往往比我們的題庫**差**。這六種「差異」不是內容錯，
 * 照抄會讓題庫退步，而且退步後不會觸發任何告警：
 *
 *   1. PUA 豆腐字被塞回來 —— 原卷 U+E2C6/U+EEE7/U+EF08 夾在字中間
 *      （藥師二階 101030 #31「非核酸<U+E2E6>反轉錄」）。全站早就清過，見 project_pua_cleanup
 *   2. 零寬空格取代普通空白 —— U+200B，看不見但會害搜尋失效
 *   3. 字元重排 —— 選項開頭的「A」被當成標記搬到尾端
 *      （護理師 104100 #76「A、B、C型流行性感冒病毒」→「、B、C 型流行性感冒病毒A」）
 *   4. 箭頭被吃掉 —— 排序題的「慢濾→沉澱→混凝→快濾」變成「慢濾沉澱混凝快濾」，
 *      整題就沒有意義了（公衛師 115100 #6、#23）
 *   5. 全形標點退化成半形、® 變成 ○R
 *   6. **只差一個字** —— 這是壞字（project_broken_glyphs）的簽章，不是內容錯。
 *      獸醫 102100 #42 家鼷鼠→家蹊鼠、營養師 103100 #40 鄰苯二甲酸酯→磷苯二甲酸酯
 *      都是原卷字形壞掉而我們是對的。單字差異在這裡是擲銅板（實測 2 好 3 壞），
 *      所以只有在**同一題還有另外兩個選項是多字差異**時才採信
 *      ——那代表整組選項真的在重建，證據夠強。
 */
const INVIS = /[\uE000-\uF8FF\u200B-\u200F\uFEFF]/
const WS = t => String(t).replace(/[\s\u3000]/g, '')
const NF = t => WS(t).normalize('NFKC')
const TYPO = /[®©™℃℉°±×÷→←↑↓⇒⇐⁻⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉αβγδεμπσω]/g
const bag = t => [...NF(t)].sort().join('')
const cnt = (t, re) => (String(t).match(re) || []).length

/** 把 core 差異壓成編輯距離，用來認「只差一個字」。 */
function dist(a, b) {
  const A = [...a], B = [...b]
  if (Math.abs(A.length - B.length) > 2) return 99
  let prev = Array.from({ length: B.length + 1 }, (_, i) => i)
  for (let i = 1; i <= A.length; i++) {
    const cur = [i]
    for (let j = 1; j <= B.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[B.length]
}

/**
 * 這個選項的差異是「內容不同」嗎？
 * 回傳 'strong'（多字差異，證據夠）｜'weak'（只差一字，要同題佐證）｜false（排版退步）
 */
function substantive(mine, theirs) {
  if (INVIS.test(theirs)) return false                             // 1 + 2
  if (NF(mine) === NF(theirs)) return false
  if (bag(mine) === bag(theirs)) return false                      // 3
  if (/^[、，。）)\]}；;:：·…]/.test(theirs.trim())) return false
  if (cnt(mine, TYPO) > cnt(theirs, TYPO)) return false            // 4 + 5
  // ⚠️ 不要用「全形字變少」當閘。純粹的 ：→: 已經被上面的 NF 閘吃掉了，
  //    而「我們的 AI 改寫版用了較多、。，原卷正確版用了較少」是常態
  //    （醫師一階 103100 #82 的 C、D 就是這樣被擋掉，結果只換了 A、B，
  //    留下一半官方一半 AI 的混搭 —— 比兩邊都糟）。
  return dist(NF(mine), NF(theirs)) <= 1 ? 'weak' : 'strong'       // 6
}

/**
 * ⚠️ 閘 3 對「含數字／上下標／公式」的選項是**結構性恆真**，不能用。
 *
 * ms 的兩個 matcher 都是從同一份 PDF 的文字層抽的，theirs 也是從那份 PDF 解析的，
 * 所以 theirs 必然找得到。而我們題庫裡的 `1.6×10⁻²⁷ kg` 在文字層是獨立 run 的上標，
 * 攤平成 `10-27`，mine 必然找不到 —— 於是閘 3 判「我們錯」，
 * 把正確的上標版本覆蓋成攤平版本。
 *
 * 2026-10-25 全站跑過一次，303 題的字元對照表就是這個簽章：
 *   103× ⁻→-   54× 0→D   44× .→0   42× D→C   32× C→×   29× D→S   22× 1→.
 * 放射師／醫師一階／醫檢師／聽力師的數值選項被打亂。已整批 revert。
 *
 * 所以只收**純中文散文**的選項差異（tcm2 那批驗證乾淨的就是這種）。
 */
const RISKY = /[0-9０-９°²³¹⁰-₟０-９×÷±~∼%‰/＋+\-−–—]/
const LATIN = /[A-Za-z]/
function proseOnly(x) {
  if (RISKY.test(x)) return false
  // 零星的英文學名可以（「蛇串瘡（herpes zoster）」），但整段英文不行
  const latin = (x.match(/[A-Za-z]/g) || []).length
  const cjk = (x.match(/[一-鿿]/g) || []).length
  if (LATIN.test(x) && latin > cjk) return false
  return cjk >= 3
}

/** 原卷的 `�` 當萬用字元（字型沒有合法 ToUnicode 對應）。 */
function makeMatcher(T) {
  const holes = []
  for (let i = 0; i < T.length; i++) if (T[i] === '�') holes.push(i)
  return w => {
    if (!w) return true
    if (T.includes(w)) return true
    for (const h of holes) {
      for (let off = Math.max(0, h - w.length + 1); off <= h; off++) {
        if (off + w.length > T.length) continue
        let ok = true
        for (let j = 0; j < w.length; j++) {
          const c = T[off + j]
          if (c !== '�' && c !== w[j]) { ok = false; break }
        }
        if (ok) return true
      }
    }
    return false
  }
}

;(async () => {
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f))
  let fixed = 0
  const skip = {}
  const bump = k => { skip[k] = (skip[k] || 0) + 1 }

  for (const f of files) {
    const exam = EXAM(f)
    if (SKIP.has(exam) || (only && exam !== only)) continue
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'))
    const arr = j.questions || j
    if (!Array.isArray(arr)) continue

    const byPaper = new Map()
    for (const q of arr) {
      if (!q.exam_code || !q.subject || !q.options) continue
      const k = q.exam_code + '\u0000' + q.subject
      if (!byPaper.has(k)) byPaper.set(k, [])
      byPaper.get(k).push(q)
    }
    let touched = false
    for (const [k, items] of byPaper) {
      const [code, subject] = k.split('\u0000')
      let parsed, marker = null, ms, ans
      try {
        const p = await resolvePaper({ exam, code: String(code), subject, year: String(items[0].roc_year), items })
        if (!p) throw new Error('no paper')
        const buf = await fetchSheet('Q', String(code), p.c, p.s)
        ms = [skeleton(await pdfText(buf)), skeleton(await pdfTextClean(buf))].map(makeMatcher)
        parsed = await paperQuestions(String(code), p.c, p.s)
        try { marker = await markerOptions(buf) } catch {}
        ans = (await sheetMap(String(code), p.c, p.s, Math.max(110, items.length))).map
      } catch { bump('原卷取不到'); continue }

      for (const q of items) {
        if (/【題組情境】|承上題|承上圖/.test(String(q.question))) continue   // 情境是刻意併入的
        let o = parsed.get(+q.number)
        const ok = x => x && L.every(c => bare(x.options[c])) && new Set(L.map(c => bare(x.options[c]))).size === 4
        if (!ok(o) && marker && ok(marker.get(+q.number))) o = marker.get(+q.number)
        if (!ok(o)) { bump('原卷選項不乾淨'); continue }
        const oOpts = L.map(c => String(o.options[c]))
        if (oOpts.some(x => /_{3,}/.test(x) || /(?:[A-Z]\d){3,}/.test(x))) { bump('原卷下標炸開'); continue }

        // 閘 1：題幹要對得上
        const a = skeleton(q.question), b = skeleton(o.stem)
        if (!a || !b) { bump('題幹太短'); continue }
        if (!(a === b || a.startsWith(b) || b.startsWith(a))) { bump('題幹對不上，不是同一題'); continue }

        // 閘 3：每一個不同的選項，我們的版本都要在原卷全文找不到
        let diff = L.map((c, i) => ({ c, mine: String(q.options[c] || ''), theirs: oOpts[i], lv: substantive(String(q.options[c] || ''), oOpts[i]) }))
          .filter(x => skeleton(x.mine) !== skeleton(x.theirs) && x.lv)
        if (diff.filter(x => x.lv === 'strong').length < 2) diff = diff.filter(x => x.lv === 'strong')
        if (!diff.length) continue
        if (diff.some(x => skeleton(x.mine).length < MIN_OPT)) { bump('選項太短，判不出來'); continue }
        // ⚠️ 互為子字串＝只是一方被截斷，不是內容不同。照改會弄丟文字
        //    （tcm2 111030 #74 我們的「…灼癢，有」比原卷的「…灼癢，」長）。
        if (diff.some(x => {
          const m = skeleton(x.mine), t = skeleton(x.theirs)
          return m.includes(t) || t.includes(m)
        })) { bump('互為子字串（截斷差異），不動'); continue }
        // ⚠️ 見 proseOnly 註解：閘 3 對含數字／上下標的選項恆真，必須先擋掉
        if (diff.some(x => !proseOnly(x.mine) || !proseOnly(x.theirs))) { bump('含數字／公式，判準不適用'); continue }
        if (diff.some(x => ms.some(m => m(skeleton(x.mine))))) { bump('我們的選項在原卷找得到，不敢斷定'); continue }
        if (diff.some(x => !ms.some(m => m(skeleton(x.theirs))))) { bump('原卷解析出的選項在全文也找不到'); continue }

        const sheet = ans.get(+q.number)
        const multi = String(q.answer || '').includes(',')
        if (!multi && !(sheet && /^[ABCD]$/.test(String(sheet)))) { bump('答案卷讀不到'); continue }
        const newAnswer = multi ? q.answer : String(sheet)

        console.log(`${exam} ${code} ${subject.slice(0, 14)} #${q.number}${String(q.answer) !== String(newAnswer) ? `  答 ${q.answer}→${newAnswer}` : ''}`)
        console.log(`  題幹: ${String(o.stem).replace(/\s+/g, ' ').slice(0, 56)}`)
        for (const d of diff) {
          console.log(`   ${d.c}  ${d.mine.slice(0, 34)}  →  ${d.theirs.slice(0, 34)}`)
          // 顯示上看不出差別時（碼位不同），把第一個相異字元印出來
          const m = [...skeleton(d.mine)], t = [...skeleton(d.theirs)]
          let i = 0; while (i < m.length && i < t.length && m[i] === t[i]) i++
          if (m[i] && t[i] && d.mine.slice(0, 34) === d.theirs.slice(0, 34)) {
            console.log(`        第 ${i} 字不同：${m[i]}(U+${m[i].codePointAt(0).toString(16).toUpperCase()}) → ${t[i]}(U+${t[i].codePointAt(0).toString(16).toUpperCase()})`)
          }
        }
        console.log('')
        if (APPLY) {
          // 只換判定為「內容不同」的那幾個選項，排版較好的保留我們的
          const pick = new Map(diff.map(x => [x.c, x.theirs]))
          q.options = Object.fromEntries(L.map(c => [c, pick.has(c) ? pick.get(c) : String(q.options[c])]))
          q.answer = newAnswer
        }
        fixed++
        touched = true
      }
    }
    if (touched && APPLY) atomicWriteJson(path.join(BK, f), j)
  }
  console.log(`重建 ${fixed} 題${APPLY ? '' : '（dry-run）'}`)
  if (Object.keys(skip).length) console.log('跳過：' + JSON.stringify(skip))
  if (APPLY && fixed) console.log('✅ 已寫回')
})().catch(e => { console.error(e.stack); process.exit(1) })
