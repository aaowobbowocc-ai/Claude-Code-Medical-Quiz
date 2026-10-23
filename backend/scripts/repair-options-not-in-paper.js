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
        const diff = L.map((c, i) => ({ c, mine: String(q.options[c] || ''), theirs: oOpts[i] }))
          .filter(x => skeleton(x.mine) !== skeleton(x.theirs))
        if (!diff.length) continue
        if (diff.some(x => skeleton(x.mine).length < MIN_OPT)) { bump('選項太短，判不出來'); continue }
        // ⚠️ 互為子字串＝只是一方被截斷，不是內容不同。照改會弄丟文字
        //    （tcm2 111030 #74 我們的「…灼癢，有」比原卷的「…灼癢，」長）。
        if (diff.some(x => {
          const m = skeleton(x.mine), t = skeleton(x.theirs)
          return m.includes(t) || t.includes(m)
        })) { bump('互為子字串（截斷差異），不動'); continue }
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
          q.options = { A: oOpts[0], B: oOpts[1], C: oOpts[2], D: oOpts[3] }
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
