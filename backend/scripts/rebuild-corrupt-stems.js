#!/usr/bin/env node
/**
 * 把「題幹與原卷差太多」的題直接從原卷重建。
 *
 * 來源清單是 audit-stem-corruption.js（題幹的 8 字滑動視窗有多少比例出現在
 * 原卷文字裡）。覆蓋率很低代表我們存的文字跟原卷根本不是同一段，常見成因：
 *   - 當初走 Vision OCR 補題，OCR 把中醫術語整段讀錯
 *     （「夏月在操場上練槍」→「夏日在操場上榨槍」、「脈虛無力」→「脹虛無力」）
 *   - 這個題號被別張卷的題佔走（tcm2 109030 中醫臨床醫學(三) 的 9 格裝的是
 *     中醫臨床醫學(一) 同題號的爛字複本，(三) 的真題整個不見）
 *
 * 判準很單純，而且是自我驗證的：
 *   1. 我們這題對自己那張原卷的覆蓋率 < LOW
 *   2. 原卷同題號解析得出乾淨的四個選項（非空、互不相同）
 *   3. 重建後的覆蓋率 >= HIGH，而且比原本至少高 GAIN
 * 三個都過才寫。覆蓋率低、重建後卻很高 → 我們存的那份本來就不屬於這裡。
 *
 * ⚠️ 不處理題組題（`【題組情境】` 把上一題情境併進來，覆蓋率天生偏低）。
 * ⚠️ 答案一律取答案卷；讀不到就標 incomplete，不猜。
 *
 * 前置：bash scripts/run-stem-corruption.sh
 *
 *   node scripts/rebuild-corrupt-stems.js                 # dry-run
 *   node scripts/rebuild-corrupt-stems.js --apply
 *   node scripts/rebuild-corrupt-stems.js --exam=tcm2 --low=0.5
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
const LOW = +((process.argv.find(a => a.startsWith('--low=')) || '').split('=')[1]) || 0.60
const HIGH = 0.90
const GAIN = 0.30
const N = 8
const L = ['A', 'B', 'C', 'D']
const SRC = path.join(BK, '_tmp', 'stem-corruption-all.json')
const FILE = e => e === 'doctor1' ? 'questions.json' : `questions-${e}.json`

/** 原卷的 `�`（字型沒有 Unicode 對應）當萬用字元，見 audit-stem-corruption.js。 */
function makeMatcher(T) {
  const holes = []
  for (let i = 0; i < T.length; i++) if (T[i] === '�') holes.push(i)
  return w => {
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
function cover(stem, ms) {
  const k = skeleton(String(stem))
  if (k.length < N + 4) return null
  let hit = 0, tot = 0
  for (let i = 0; i + N <= k.length; i++) { tot++; if (ms.some(m => m(k.slice(i, i + N)))) hit++ }
  return tot ? hit / tot : null
}

;(async () => {
  if (!fs.existsSync(SRC)) { console.error('缺 ' + SRC + '，先跑 bash scripts/run-stem-corruption.sh'); process.exit(1) }
  const rows = JSON.parse(fs.readFileSync(SRC, 'utf8'))
    .filter(r => !r.group && r.cover < LOW && (!only || r.exam === only))
  console.log(`清單 ${rows.length} 題（覆蓋率 < ${LOW}，排除題組題）\n`)

  const byPaper = new Map()
  for (const r of rows) {
    const k = [r.exam, r.code, r.subject].join('\u0000')
    if (!byPaper.has(k)) byPaper.set(k, [])
    byPaper.get(k).push(r)
  }

  const cache = {}
  let fixed = 0, noAns = 0
  const skip = {}
  const bump = k => { skip[k] = (skip[k] || 0) + 1 }
  for (const [key, items] of byPaper) {
    const [exam, code, subject] = key.split('\u0000')
    const f = FILE(exam)
    const j = cache[f] || (cache[f] = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')))
    const arr = j.questions || j
    const all = arr.filter(q => String(q.exam_code) === String(code) && q.subject === subject)
    let ms, parsed, ans, marker = null
    try {
      const p = await resolvePaper({ exam, code: String(code), subject, year: String(all[0]?.roc_year), items: all })
      if (!p) throw new Error('對不到原卷')
      var qbuf = await fetchSheet('Q', String(code), p.c, p.s)
      ms = [skeleton(await pdfText(qbuf)), skeleton(await pdfTextClean(qbuf))].map(makeMatcher)
      parsed = await paperQuestions(String(code), p.c, p.s)
      ans = (await sheetMap(String(code), p.c, p.s, Math.max(110, all.length))).map
      // 後備解析：paperQuestions 在某些卷上四個選項全空（標記與文字不在同一個 y、
      // 一列裡有兩到四個選項）。lib/moex-marker-options.js 靠標記的幾何位置重建。
      try { marker = await markerOptions(qbuf) } catch { marker = null }
    } catch { for (const _ of items) bump('原卷取不到'); continue }

    for (const r of items) {
      const q = all.find(x => +x.number === +r.n)
      let o = parsed.get(+r.n)
      if (!q) { bump('題庫找不到'); continue }
      const bare0 = t => String(t).replace(/[-​-‏﻿\s　]/g, '')
      const ok = x => x && L.every(k => bare0(x.options[k])) && new Set(L.map(k => bare0(x.options[k]))).size === 4
      if (!ok(o) && marker && ok(marker.get(+r.n))) o = marker.get(+r.n)   // 換後備解析
      if (!o) { bump('原卷解析不到該題號'); continue }
      const opts = L.map(x => String(o.options[x] || ''))
      // ⚠️ `!x.trim()` 擋不住塞著 PUA 或零寬字元的空格（見 apply-glyph-map.js 的同一個坑）
      const bare = t => String(t).replace(/[-​-‏﻿\s　]/g, '')
      if (opts.some(x => !bare(x)) || new Set(opts.map(bare)).size !== 4) { bump('原卷選項不乾淨'); continue }
      // 下標炸開的簽章：護理師 104030 #60 重建出「NaHCO3 3 _____ 2 _____」
      if (opts.some(x => /_{3,}/.test(x))) { bump('原卷選項下標炸開'); continue }
      // 首位數字跑到尾巴（PDF 的老毛病）：
      //   營養師 108020 #2「800 | ,0001 | ,2001 | ,4001」其實是 800/1,000/1,200/1,400
      //   營養師 108020 #16「小時內6」其實是「6小時內」
      if (opts.some(x => /^[,.，、]/.test(x.trim()))) { bump('原卷選項首位數字跑位'); continue }
      const startsDigit = opts.filter(x => /^\d/.test(x.trim())).length
      const endsDigit = opts.filter(x => /[一-鿿][0-9]+$/.test(x.trim())).length
      if (startsDigit >= 2 && endsDigit >= 1) { bump('原卷選項首位數字跑位'); continue }
      // 頁首黏進選項
      if (opts.some(x => /代號[：:]|頁次[：:]|座號[：:]/.test(x))) { bump('原卷選項黏到頁首'); continue }
      // 上下標符號炸開：醫檢師 101110 #34 的 total CO₂／HCO₃⁻ 變成
      //   「HCOPB-P | HBCOB | COB gas | COPB-2PB3B2B3B2B3」，題幹尾巴還多一串 B2B2。
      //   連續三組以上的「大寫字母＋數字」是簽章；H2O2、C6H12O6 這種真的化學式只有兩組，不會誤殺。
      const subSup = /(?:[A-Z]\d){3,}/
      if (opts.some(x => subSup.test(x)) || subSup.test(String(o.stem))) { bump('原卷上下標炸開'); continue }
      if (/[A-Z]\d[A-Z]\d\s*$/.test(String(o.stem))) { bump('原卷題幹尾巴有上下標殘渣'); continue }
      // 含圖題沒有圖就不能作答，留給 extract-missing-figures.js 另案處理
      if (/[下附上右左]\s*[圖表]|如圖|圖示|編號\s*[①-⑩]/.test(String(o.stem))) { bump('重建出來是含圖題'); continue }
      const before = cover(q.question, ms), after = cover(o.stem, ms)
      if (before === null || after === null) { bump('太短無法驗證'); continue }
      if (after < HIGH) { bump(`重建後覆蓋率仍 < ${HIGH}`); continue }
      if (after - before < GAIN) { bump('改善幅度不足'); continue }

      const a = ans.get(+r.n)
      console.log(`${exam} ${code} ${subject.slice(0, 16)} #${r.n}  覆蓋 ${Math.round(before * 100)}% → ${Math.round(after * 100)}%  答 ${q.answer}→${a || '(無)'}`)
      console.log(`  舊: ${String(q.question).replace(/\s+/g, ' ').slice(0, 58)}`)
      console.log(`  新: ${String(o.stem).replace(/\s+/g, ' ').slice(0, 58)}`)
      console.log(`  新選項: ${opts.join(' | ').slice(0, 92)}\n`)
      if (APPLY) {
        q.question = String(o.stem)
        q.options = { A: opts[0], B: opts[1], C: opts[2], D: opts[3] }
        q.explanation = ''
        delete q.disputed
        delete q.images
        delete q.incomplete
        delete q.incomplete_reason
        if (a && /^[ABCD]$/.test(String(a))) q.answer = String(a)
        else { q.incomplete = true; q.incomplete_reason = '重建時答案卷讀不到此題號'; noAns++ }
      }
      fixed++
    }
  }

  console.log(`重建 ${fixed} 題${noAns ? `（其中 ${noAns} 題無答案標隱藏）` : ''}${APPLY ? '' : '（dry-run）'}`)
  if (Object.keys(skip).length) console.log('跳過：' + JSON.stringify(skip))
  if (APPLY && fixed) {
    for (const [f, j] of Object.entries(cache)) atomicWriteJson(path.join(BK, f), j)
    console.log('✅ 已寫回')
  }
})().catch(e => { console.error(e.stack); process.exit(1) })
