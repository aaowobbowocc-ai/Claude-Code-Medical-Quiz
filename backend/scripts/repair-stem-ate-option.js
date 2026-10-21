#!/usr/bin/env node
/**
 * 修「題幹吃掉選項」：題幹在問號之後還黏著選項 A 的前半，選項 A 只剩尾巴。
 *
 *   題幹: 有關發炎性腸道疾病（IBD）敘述，下列何者錯誤？克隆氏症可能侵犯腸道任何部位；潰瘍性結腸炎通常影
 *   A:    響結腸及直腸                ← 只剩尾巴
 *
 * 使用者回報 952（營養師 108-2 膳食療養學 #17）就是這樣。
 * 同一位回報者先前那筆（108-1 營養學 #10）也是選項位移，兩次都對。
 *
 * **既有的 pollution 規則抓不到這種。** 那條規則比對「題幹尾巴」與「選項 A」
 * 是否**重複**（選項漏進題幹但 A 還完整）；這裡是 A 被**切成兩半**，
 * 兩段文字不重複，所以規則不會響。
 *
 * 判準不是猜內容，是**文字守恆**：
 *   我們的「題幹 + 四選項」串接後，要與原卷的「題幹 + 四選項」完全相同
 *   （正規化掉空白與全半形）。相同就代表只是切點不同、沒有內容錯置。
 * 這招在郵局 parser 那次驗證過 29 題全中、0 誤判。
 *
 *   node scripts/repair-stem-ate-option.js            # dry-run
 *   node scripts/repair-stem-ate-option.js --apply
 *   node scripts/repair-stem-ate-option.js --exam=customs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve')
const { paperQuestions } = require('./fill-civil-gaps')
const { markerOptions } = require('./lib/moex-marker-options')
const { sheetMap } = require('./lib/moex-answer-geo')
const { atomicWriteJson } = require('./lib/atomic-write')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1]
const L = ['A', 'B', 'C', 'D']
const EXAM = f => f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '')
const SKIP = new Set(['gsat', 'ast', 'driver-car', 'driver-moto', 'post-indoor', 'post-outdoor',
  'railway-admin', 'railway-transport', 'state-finance', 'state-hr', 'state-it', 'state-mgmt',
  'teacher-elementary', 'teacher-kindergarten', 'teacher-secondary', 'teacher-special', 'teacher-special-gifted'])

const norm = t => String(t || '').normalize('NFKC').replace(/[\s　]/g, '')
const bare = t => String(t).replace(/[-​-‏﻿\s　]/g, '')
/** 一題的全文（題幹 + 四選項），用來驗文字守恆。 */
const seq = (stem, opts) => norm(stem) + opts.map(norm).join('')

/** 題幹在問號後還有長尾、而且選項 A 明顯比同伴短 → 疑似被切開。 */
function looksSplit(q) {
  if (!q.question || !q.options) return false
  if (/【題組情境】|承上題|承上圖/.test(q.question)) return false
  const m = String(q.question).match(/[\s\S]*[?？]\s*([\s\S]+)$/)
  if (!m || m[1].trim().length < 15) return false
  const a = String(q.options.A || '')
  if (a.length < 2) return false
  const others = L.slice(1).map(k => String(q.options[k] || '').length).filter(Boolean).sort((x, y) => x - y)
  if (!others.length) return false
  return a.length < others[Math.floor(others.length / 2)] * 0.5
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
    const cands = arr.filter(looksSplit)
    if (!cands.length) continue

    const byPaper = new Map()
    for (const q of cands) {
      const k = q.exam_code + '\u0000' + q.subject
      if (!byPaper.has(k)) byPaper.set(k, [])
      byPaper.get(k).push(q)
    }
    let touched = false
    for (const [k, items] of byPaper) {
      const [code, subject] = k.split('\u0000')
      const all = arr.filter(q => String(q.exam_code) === String(code) && q.subject === subject)
      let parsed, marker = null, ans = null
      try {
        const p = await resolvePaper({ exam, code: String(code), subject, year: String(all[0]?.roc_year), items: all })
        if (!p) throw new Error('no paper')
        const buf = await fetchSheet('Q', String(code), p.c, p.s)
        parsed = await paperQuestions(String(code), p.c, p.s)
        try { marker = await markerOptions(buf) } catch {}
        ans = (await sheetMap(String(code), p.c, p.s, Math.max(110, all.length))).map
      } catch { for (const _ of items) bump('原卷取不到'); continue }

      for (const q of items) {
        let o = parsed.get(+q.number)
        const ok = x => x && L.every(c => bare(x.options[c])) && new Set(L.map(c => bare(x.options[c]))).size === 4
        if (!ok(o) && marker && ok(marker.get(+q.number))) o = marker.get(+q.number)
        if (!ok(o)) { bump('原卷選項不乾淨'); continue }
        const oOpts = L.map(c => String(o.options[c]))
        if (oOpts.some(x => /_{3,}/.test(x) || /(?:[A-Z]\d){3,}/.test(x))) { bump('原卷下標炸開'); continue }

        const mine = seq(q.question, L.map(c => String(q.options[c] || '')))
        const theirs = seq(o.stem, oOpts)
        if (mine !== theirs) { bump('文字不守恆，另有問題'); continue }
        if (norm(q.question) === norm(o.stem)) { bump('題幹本來就一樣'); continue }

        // ⚠️ 選項重建後答案字母可能要跟著改。
        //    多數是「A 被切成兩半」，B/C/D 沒動，字母照舊；
        //    但也有整組位移的（醫師一階 103100 #86 的 A 從「Pearson」變成
        //    「單一樣本t 檢定」），那時舊字母會指到錯的選項。
        //    一律以考選部答案卷為準；讀不到就不動這題。
        //    多字母（C,D）是官方「兩個都給分」的爭議題，保留原答案不碰。
        const a = ans && ans.get(+q.number)
        const multi = String(q.answer || '').includes(',')
        if (!multi && !(a && /^[ABCD]$/.test(String(a)))) { bump('答案卷讀不到，不敢動'); continue }
        const newAnswer = multi ? q.answer : String(a)

        console.log(`${exam} ${code} ${subject.slice(0, 14)} #${q.number}${String(q.answer) !== String(newAnswer) ? `  答 ${q.answer}→${newAnswer}` : ''}`)
        console.log(`  舊題幹: ${String(q.question).replace(/\s+/g, ' ').slice(0, 62)}`)
        console.log(`  新題幹: ${String(o.stem).replace(/\s+/g, ' ').slice(0, 62)}`)
        console.log(`  舊 A: ${String(q.options.A).slice(0, 34)}   新 A: ${oOpts[0].slice(0, 34)}\n`)
        if (APPLY) {
          q.question = String(o.stem)
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
