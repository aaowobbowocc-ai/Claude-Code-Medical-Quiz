#!/usr/bin/env node
/**
 * 解出「壞字 → 正確字」的對照表。**只讀不寫，只產生表給人看。**
 *
 * 來龍去脈：
 * audit-stem-corruption.js 找出 1,215 題題幹與原卷不符。統計用字發現一批 lift 破百、
 * 幾乎只出現在壞題裡的字：蜻 蠋 菘 甀 蛉 蹋 躏 葝 蒠 败 觑 褺…
 *
 * 一開始以為是 OCR 錯字，想從原卷讀回正確字。**原卷讀不到**——
 * `paperQuestions` 在那些位置吐的是 `�`（U+FFFD）：
 *     我們：有關氧氣治蠋之危險併發症
 *     原卷：有關氧氣治�之危險併發症
 * 這些 PDF 的字型根本沒有合法的 ToUnicode 對應。當初建題庫的抽取器硬猜了一個字，
 * 猜出來的碼位固定（同一個字形永遠猜成同一個字），所以是一致的 1:1 替換。
 *
 * 原卷給不了答案，但**語料可以**：「蠋」只出現在「氧氣治蠋」「噴霧治蠋」
 * 「維生治蠋」，而乾淨語料裡「治療」有上萬次、「治蠋」零次。
 * 用前後 bigram 的似然值就能把正確字算出來，而且算得出信心。
 *
 * 做法：
 *   1. 乾淨語料 = 全站不含任何可疑字的題幹與選項，統計 bigram。
 *   2. 對每個可疑字 X，蒐集它所有出現處的前後文 (prev, X, next)。
 *   3. 候選字 Y 的分數 = Σ log P(prev→Y) + log P(Y→next)。
 *   4. 回報最佳候選與第二名的差距（margin）。差距小的不要信，人工判。
 *
 * ⚠️ 這是統計推論，不是從原卷讀出來的。margin 低的、出現次數少的都要人看過。
 * 套用前請用 apply-glyph-map.js 的 --dry-run 逐題確認。
 *
 *   node scripts/decipher-glyph-map.js
 *   node scripts/decipher-glyph-map.js --min-count=3
 */
const fs = require('fs')
const path = require('path')

const BK = path.join(__dirname, '..')
const MINC = +((process.argv.find(a => a.startsWith('--min-count=')) || '').split('=')[1]) || 4
const CJK = /[一-鿿]/

/** lift 破百、幾乎只出現在損壞題幹裡的字。來自 audit-stem-corruption.js 的統計。 */
const SUSPECT = [...'蜕菘蜻蠋甀葝败躏蹋褺蛉蚮蛯觑荊谜蒠装']

;(async () => {
  const suspect = new Set(SUSPECT)
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f))

  // ── 1. 乾淨語料的 bigram ───────────────────────────────────────────
  const fwd = new Map()   // prev → Map(next → n)
  const bwd = new Map()   // next → Map(prev → n)
  const uni = new Map()
  const contexts = new Map()  // 可疑字 → [{prev,next}]
  let cleanChars = 0

  const bump = (m, a, b) => {
    if (!m.has(a)) m.set(a, new Map())
    const x = m.get(a)
    x.set(b, (x.get(b) || 0) + 1)
  }

  for (const f of files) {
    const arr = (j => j.questions || j)(JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')))
    if (!Array.isArray(arr)) continue
    for (const q of arr) {
      const texts = [String(q.question || ''), ...['A', 'B', 'C', 'D'].map(k => String(q.options?.[k] || ''))]
      for (const raw of texts) {
        const s = raw.replace(/\s+/g, '')
        const dirty = [...s].some(c => suspect.has(c))
        for (let i = 0; i < s.length; i++) {
          const c = s[i]
          if (suspect.has(c)) {
            // 前後文只取 CJK，標點與英數當作沒有
            const prev = i > 0 && CJK.test(s[i - 1]) && !suspect.has(s[i - 1]) ? s[i - 1] : null
            const next = i + 1 < s.length && CJK.test(s[i + 1]) && !suspect.has(s[i + 1]) ? s[i + 1] : null
            if (prev || next) {
              if (!contexts.has(c)) contexts.set(c, [])
              contexts.get(c).push({ prev, next })
            }
            continue
          }
          if (dirty) continue                       // 髒句子不進乾淨語料
          if (!CJK.test(c)) continue
          cleanChars++
          uni.set(c, (uni.get(c) || 0) + 1)
          const nx = s[i + 1]
          if (nx && CJK.test(nx) && !suspect.has(nx)) { bump(fwd, c, nx); bump(bwd, nx, c) }
        }
      }
    }
  }
  console.log(`乾淨語料 ${cleanChars.toLocaleString()} 字，${uni.size} 個相異字\n`)

  // ── 2. 逐字解 ────────────────────────────────────────────────────
  const SMOOTH = 0.4
  const total = cleanChars || 1
  const cand = [...uni.entries()].filter(([, n]) => n >= 20).map(([c]) => c)
  const out = {}
  for (const X of SUSPECT) {
    const ctx = contexts.get(X) || []
    if (ctx.length < MINC) continue
    const scores = []
    for (const Y of cand) {
      let s = 0
      // ⚠️ 兩項都用 P(Y|context) 會把 Y 的先驗平方，「的」就永遠贏
      //    （甀 本來是「瘀」、蛉 是「量」、褺 是「理」，全被判成「的」）。
      //    正規的 bigram 鏈是 P(Y|prev) × P(next|Y)，只帶一次 Y 的先驗。
      const nY = (uni.get(Y) || 0) + SMOOTH * uni.size
      for (const { prev, next } of ctx) {
        if (prev) s += Math.log(((fwd.get(prev)?.get(Y) || 0) + SMOOTH) / ((uni.get(prev) || 1) + SMOOTH * uni.size))
        if (next) s += Math.log(((fwd.get(Y)?.get(next) || 0) + SMOOTH) / nY)
      }
      // ⚠️ 不要加「偏好常用字」的先驗。試過 0.15 的權重，結果把 甀(瘀)、褺(理)、
      //    蚮(兩) 全部拉成「的」——「的」太常見，先驗一加就淹掉 bigram 的訊號。
      //    bigram 本身的鑑別力已經夠。
      scores.push({ Y, s })
    }
    scores.sort((a, b) => b.s - a.s)
    const [a, b] = scores
    const margin = (a.s - b.s) / ctx.length              // 每次出現平均領先多少 log 單位
    out[X] = { count: ctx.length, best: a.Y, top3: scores.slice(0, 3).map(x => x.Y), margin: +margin.toFixed(2) }
    const flag = margin >= 1.5 ? '可信  ' : margin >= 0.7 ? '偏弱  ' : '不可信'
    const sample = ctx.slice(0, 4).map(c => `${c.prev || '·'}${X}${c.next || '·'}`).join(' ')
    console.log(`  ${X} → ${a.Y}  ${flag} ${String(ctx.length).padStart(3)}次 margin ${margin.toFixed(2).padStart(5)}  前三 ${scores.slice(0, 3).map(x => x.Y).join('')}   例：${sample}`)
  }

  const dest = path.join(BK, '_tmp', 'glyph-map.json')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, JSON.stringify(out, null, 1))
  console.log(`\n📄 ${dest}`)
})().catch(e => { console.error(e.stack); process.exit(1) })
