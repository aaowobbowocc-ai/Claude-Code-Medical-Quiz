#!/usr/bin/env node
/**
 * 把被 AI 改寫過的選項換回考選部原文。
 *
 *   護理師 104100 基礎醫學 #45
 *     我們：「A型肝炎主要經由血液及體液傳播。」      ← 連事實都錯（A 肝是糞口傳染）
 *     原卷：「A 型肝炎主要是經血液傳染，是一種可自癒的感染症」
 *
 *   醫師一階 103100 醫學(一) #90
 *     我們：「統計檢定結果顯示有顯著差異，但實際上並無差異。」
 *     原卷：「兩組實際上無差異，分析結果推翻虛無假說（null hypothesis）」
 *
 * 與 repair-options-not-in-paper.js 的分工：那支要靠「我們的選項在原卷
 * 全文找不到」當證據，所以一次只敢換個別選項，常造成半套重建（一半官方
 * 一半 AI，比兩邊都糟）。這支不需要那個證據，因為進場簽章本身就是證據：
 *
 *   **四個選項全部以句號結尾** —— 考選部的選項從不加句號。
 *
 * 全站只有 43 題中這個簽章，30 題是純文字、13 題是含圖選項被 AI 描述
 * （那 13 題另案處理，不在這支範圍）。
 *
 * ⚠️ **簽章不是 100% 可靠，有兩題是誤報**（2026-10-27 逐字核對原卷確認）：
 *      牙醫二階 111020 卷一 #70（Miller 牙齦萎縮分類）
 *      藥師一階 112100 卷三 #21（中華藥典軟膏劑重量差異試驗）
 *    這兩份卷的選項**考選部本來就用句號結尾**，題庫內容與原卷逐字相符，
 *    只差全半形標點。不要再去「修」它們。
 *    剩下的 gsat_115 國文 #14 是大考中心的卷，resolvePaper 不支援，另案。
 *
 * 四道閘：
 *   1. 題幹要對得上（正規化後相同或互為前綴）
 *   2. 原卷四個選項乾淨：非空、互不相同、不含 PUA／零寬字元、不含 ___
 *   3. 原卷選項本身不能也是句號結尾（那就不是我們想換的來源）
 *   4. 答案一律取答案卷；多字母的爭議題保留原答案
 *
 *   node scripts/repair-ai-rewritten-options.js --exam=nursing          # dry-run
 *   node scripts/repair-ai-rewritten-options.js --exam=nursing --apply
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve')
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
/** 不是考選部來源的考試（學測/分科/駕照/國營/郵政/鐵路/教檢）。 */
const SKIP = new Set(['gsat', 'ast', 'driver-car', 'driver-moto', 'post-indoor', 'post-outdoor',
  'railway-admin', 'railway-transport', 'state-finance', 'state-hr', 'state-it', 'state-mgmt',
  'teacher-elementary', 'teacher-kindergarten', 'teacher-secondary', 'teacher-special', 'teacher-special-gifted'])

const INVIS = /[-​-‏﻿]/
const bare = t => String(t).replace(/[-​-‏﻿\s　]/g, '')
/** 含圖選項被 AI 描述的那 13 題不在範圍（要補圖，不是換文字）。 */
const IMGDESC = /顯示|圖示為|示意圖|曲線圖|左圖|右圖|上圖|下圖|此圖|圖中/
// ⚠️ 只看**選項**本身，不看題幹。題幹提到「如下圖」只代表題目附圖，
//    不代表選項是圖 —— 醫師二階 107080 醫學(六) #22 題幹有「耳鏡檢查如下圖」，
//    但四個選項是純文字的聽力檢查結果，該走文字重建。
const isImageQ = (q, o) =>
  o.filter(x => IMGDESC.test(x)).length >= 2 || o.some(x => x.length > 120)

;(async () => {
  let fixed = 0
  const skip = {}
  const bump = k => { skip[k] = (skip[k] || 0) + 1 }

  for (const f of fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f))) {
    const exam = EXAM(f)
    if (SKIP.has(exam) || (only && exam !== only)) continue
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'))
    const arr = j.questions || j
    if (!Array.isArray(arr)) continue

    const cands = arr.filter(q => {
      const o = L.map(k => String(q.options?.[k] || ''))
      if (o.some(x => !x)) return false
      if (!o.every(x => /。\s*$/.test(x))) return false
      if (isImageQ(q, o)) { bump('含圖選項的 AI 描述，另案補圖'); return false }
      return true
    })
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
      let parsed, marker = null, ans
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
        if (oOpts.some(x => INVIS.test(x))) { bump('原卷選項含 PUA／零寬字元'); continue }
        if (oOpts.some(x => /_{3,}/.test(x) || /(?:[A-Z]\d){3,}/.test(x))) { bump('原卷下標炸開'); continue }
        // ⚠️ 「非空且互不相同」不足以擋掉解析失敗。醫檢師 108030 #60 的原卷
        //    解出來是「a」「b」「c」「d」四個單字母，照抄會把整題毀掉。
        const lenNew = oOpts.reduce((s, x) => s + bare(x).length, 0)
        const lenOld = L.reduce((s, c) => s + bare(q.options[c]).length, 0)
        if (oOpts.some(x => bare(x).length < 2) || lenNew < lenOld * 0.3) { bump('原卷選項太短，解析失敗'); continue }
        if (oOpts.every(x => /。\s*$/.test(x))) { bump('原卷也是句號結尾，來源不對'); continue }

        const a = skeleton(q.question), b = skeleton(o.stem)
        if (!a || !b) { bump('題幹太短'); continue }
        if (!(a === b || a.startsWith(b) || b.startsWith(a))) { bump('題幹對不上，不是同一題'); continue }

        const sheet = ans.get(+q.number)
        const multi = String(q.answer || '').includes(',')
        if (!multi && !(sheet && /^[ABCD]$/.test(String(sheet)))) { bump('答案卷讀不到'); continue }
        const newAnswer = multi ? q.answer : String(sheet)

        console.log(`${exam} ${code} ${subject.slice(0, 14)} #${q.number}  答 ${q.answer}${String(q.answer) !== String(newAnswer) ? '→' + newAnswer : ''}`)
        console.log(`  ${String(o.stem).replace(/\s+/g, ' ').slice(0, 72)}`)
        for (let i = 0; i < 4; i++) {
          const mine = String(q.options[L[i]])
          if (skeleton(mine) === skeleton(oOpts[i])) { console.log(`   ${L[i]}  （不變）${oOpts[i].slice(0, 48)}`); continue }
          console.log(`   ${L[i]} 舊 ${mine.slice(0, 50)}`)
          console.log(`     新 ${oOpts[i].slice(0, 50)}`)
        }
        console.log('')
        if (APPLY) {
          q.options = { A: oOpts[0], B: oOpts[1], C: oOpts[2], D: oOpts[3] }
          q.answer = newAnswer
        }
        fixed++; touched = true
      }
    }
    if (touched && APPLY) atomicWriteJson(path.join(BK, f), j)
  }
  console.log(`重建 ${fixed} 題${APPLY ? '' : '（dry-run）'}`)
  if (Object.keys(skip).length) console.log('跳過：' + JSON.stringify(skip))
  if (APPLY && fixed) console.log('✅ 已寫回')
})().catch(e => { console.error(e.stack); process.exit(1) })
