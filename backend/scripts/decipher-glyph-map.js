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

/**
 * 自動找可疑字：**一個字如果它的前後搭配幾乎從不出現在乾淨語料裡，它就可疑。**
 *
 * 第一版是把肉眼挑出來的字寫死在這裡。那會漏——修完第一批 13 個字之後，
 * diff 裡馬上又看到 輸蟾管（尿）、襬狀上皮癌（鱗）、醫學裩理（倫）、
 * 血流動蜄（力）、赇蟾病（糖尿）、葲考線（參）、豣片（切）。
 * 壞字是一整批同時產生的，要靠統計一次抓完，不是一輪一輪用眼睛撿。
 *
 * 判準：這個字出現 >= MIN_OCC 次，而且其中 >= 85% 的出現處，
 * 前後兩個 bigram 在乾淨語料裡**都沒見過**。正常用字不可能這樣。
 */
function findSuspects(all, fwdSeen, uniAll) {
  const out = []
  for (const [c, occ] of all) {
    if (occ.length < MIN_OCC) continue
    let orphan = 0
    for (const { prev, next } of occ) {
      const okP = prev && fwdSeen.get(prev)?.has(c)
      const okN = next && fwdSeen.get(c)?.has(next)
      if (!okP && !okN) orphan++
    }
    if (orphan / occ.length >= 0.85) out.push({ c, n: occ.length, orphan })
  }
  return out.sort((a, b) => b.n - a.n)
}
const MIN_OCC = 4
const KNOWN_FIXED = [...'蜻蠋躏觑败蒠蹋菘装褺甀蜕葝']   // 上一輪已經修掉的
const NEVER = [...'荊蛉']                              // 有合法用法，不要碰

;(async () => {
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f))
  const sents = []
  for (const f of files) {
    const arr = (j => j.questions || j)(JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')))
    if (!Array.isArray(arr)) continue
    for (const q of arr) {
      for (const raw of [String(q.question || ''), ...['A', 'B', 'C', 'D'].map(k => String(q.options?.[k] || ''))]) {
        const t = raw.replace(/\s+/g, '')
        if (t) sents.push(t)
      }
    }
  }

  // ── 全站字頻 ──────────────────────────────────────────────────
  const uniAll = new Map()
  for (const s of sents) for (const c of s) if (CJK.test(c)) uniAll.set(c, (uniAll.get(c) || 0) + 1)

  // ── 「乾淨」bigram：排除所有罕用字（全站 < RARE 次）之後統計。
  //    壞字全都是罕用字，排掉它們才不會讓「治蠋」這種壞搭配被當成合法。
  const RARE = 50
  const rare = c => (uniAll.get(c) || 0) < RARE
  const fwdSeen = new Map()   // a → Set(b)
  const fwd = new Map(), uni = new Map()
  let cleanChars = 0
  const bump = (m, a, b) => { if (!m.has(a)) m.set(a, new Map()); const x = m.get(a); x.set(b, (x.get(b) || 0) + 1) }
  for (const s of sents) {
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (!CJK.test(c) || rare(c)) continue
      cleanChars++
      uni.set(c, (uni.get(c) || 0) + 1)
      const n = s[i + 1]
      if (n && CJK.test(n) && !rare(n)) {
        bump(fwd, c, n)
        if (!fwdSeen.has(c)) fwdSeen.set(c, new Set())
        fwdSeen.get(c).add(n)
      }
    }
  }
  console.log(`語料 ${sents.length.toLocaleString()} 句，排除罕用字後 ${cleanChars.toLocaleString()} 字、${uni.size} 個相異字\n`)

  // ── 每個罕用字的出現前後文 ─────────────────────────────────────
  const occ = new Map()
  for (const s of sents) {
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (!CJK.test(c) || !rare(c)) continue
      const prev = i > 0 && CJK.test(s[i - 1]) && !rare(s[i - 1]) ? s[i - 1] : null
      const next = i + 1 < s.length && CJK.test(s[i + 1]) && !rare(s[i + 1]) ? s[i + 1] : null
      if (!prev && !next) continue
      if (!occ.has(c)) occ.set(c, [])
      occ.get(c).push({ prev, next })
    }
  }

  const suspects = findSuspects(occ, fwdSeen, uniAll)
    .filter(x => !NEVER.includes(x.c))
  console.log(`自動偵測到 ${suspects.length} 個可疑字（出現 ≥${MIN_OCC} 次、≥85% 的前後搭配在語料裡沒見過）\n`)

  // ── 逐字解 ──────────────────────────────────────────────────
  const SMOOTH = 0.4
  const cand = [...uni.entries()].filter(([, n]) => n >= 20).map(([c]) => c)
  const out = {}
  for (const { c: X, n } of suspects) {
    const ctx = occ.get(X)
    const scores = []
    for (const Y of cand) {
      let s = 0
      const nY = (uni.get(Y) || 0) + SMOOTH * uni.size
      for (const { prev, next } of ctx) {
        if (prev) s += Math.log(((fwd.get(prev)?.get(Y) || 0) + SMOOTH) / ((uni.get(prev) || 1) + SMOOTH * uni.size))
        if (next) s += Math.log(((fwd.get(Y)?.get(next) || 0) + SMOOTH) / nY)
      }
      scores.push({ Y, s })
    }
    scores.sort((a, b) => b.s - a.s)
    const [a, b] = scores
    const margin = (a.s - b.s) / ctx.length
    const done = KNOWN_FIXED.includes(X)
    out[X] = { count: ctx.length, best: a.Y, top3: scores.slice(0, 3).map(x => x.Y), margin: +margin.toFixed(2), alreadyFixed: done }
    const flag = margin >= 1.5 ? '可信  ' : margin >= 0.7 ? '偏弱  ' : '不可信'
    const sample = ctx.slice(0, 4).map(c => `${c.prev || '·'}${X}${c.next || '·'}`).join(' ')
    console.log(`  ${X} → ${a.Y}  ${flag} ${String(ctx.length).padStart(3)}次 margin ${margin.toFixed(2).padStart(5)}  前三 ${scores.slice(0, 3).map(x => x.Y).join('')}   例：${sample}`)
  }

  const dest = path.join(BK, '_tmp', 'glyph-map.json')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, JSON.stringify(out, null, 1))
  console.log(`\n📄 ${dest}`)
})().catch(e => { console.error(e.stack); process.exit(1) })
