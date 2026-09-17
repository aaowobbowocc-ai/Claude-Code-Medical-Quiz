#!/usr/bin/env node
/**
 * 段落填空／閱讀測驗題組自足化：把原卷的文章併進該題組每一題的題幹。
 *
 * 這類題在考選部原卷長這樣：
 *   請依下文回答第 11 題至第 15 題
 *   Before the invention of the at-home refrigerator in 1913, ...  11  it had been
 *   preserved. Jams, jellies ... of days  12  as methods of ...
 *   11 (A) once (B) or else (C) unless (D) since
 *   12 (A) past (B) passing (C) passed (D) to pass
 *
 * 題目本體在文章裡（空格編號就是題號），所以拆成「一題一列」之後，
 * 題幹就只剩下選項或空白——我們題庫裡那些「題幹是 lasted」的題就是這樣來的。
 *
 * **不需要新題型**：專案已經有 inline-followup-context.js 的做法，
 * 把情境用「【題組情境】」前綴併進每一題的題幹，前端不必改、
 * 隨機練習單獨抽到也能作答。這支沿用同一個慣例。
 *
 * 題幹格式：
 *   【題組情境】<文章原文>
 *
 *   （本題為文章中第 11 格）
 * 文章一字不改，只加最小的定位說明——否則使用者不知道要填哪一格。
 *
 * 用法：
 *   node scripts/inline-passage-context.js --exam customs
 *   node scripts/inline-passage-context.js --exam customs --apply
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve')
const { pdfText, pdfQuestions } = require('./lib/moex-pdf-parse')
const { parseAnswerSheet } = require('./lib/moex-answer-sheet')
const { normText } = require('./lib/moex-normalize')
const { warnZero, summary } = require('./lib/coverage-guard')

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d }
const EXAM = arg('--exam')
const APPLY = process.argv.includes('--apply')
if (!EXAM) { console.error('需要 --exam'); process.exit(1) }
const DIR = path.join(__dirname, '..')
const FILE = path.join(DIR, EXAM === 'doctor1' ? 'questions.json' : `questions-${EXAM}.json`)
const MARK = '【題組情境】'
// 讀圖還原的選項（選用）。格式同 apply-vision-options 的 answers.json。
let VISION = {}
try { VISION = JSON.parse(fs.readFileSync(path.join(DIR, '_tmp', 'vision-broken', 'answers.json'), 'utf8')) } catch {}

/**
 * 從原卷切出每個題組的文章。**用行的 x 座標判斷，不要在純文字上用 regex**：
 * 純文字版會把後面所有題的選項行和頁碼一起吃進來，等於把答案印在題幹裡。
 *
 * 版面長這樣（x 是該行的左緣）：
 *   x33  請依下文回答第11 題至第15 題
 *   x57  Before the invention of the at-home refrigerator in 1913, ...
 *   x180 11                      ← 文章中的空格，x 在句中
 *   x211 it had been preserved. ...
 *   x34  11                      ← 選項列的題號，靠最左 → 文章到此為止
 *   x60  once
 *   x185 or else
 *
 * 所以：靠最左(x<40)又是題號範圍內的數字 = 選項列開始；
 *       句中的同樣數字 = 文章裡的空格，還原成「＿＿(11)＿＿」讓人看得出來。
 */
const LEFT_MARGIN = 40

function pageLines(doc, mupdf) {
  const lines = []
  for (let p = 0; p < doc.countPages(); p++) {
    const st = JSON.parse(doc.loadPage(p).toStructuredText('preserve-whitespace').asJSON())
    const rows = []
    for (const b of st.blocks || []) for (const l of b.lines || []) {
      const t = (l.text || '').trim()
      if (t) rows.push({ y: l.bbox.y, x: Math.round(l.bbox.x), t })
    }
    rows.sort((u, v) => u.y - v.y)
    lines.push(...rows)
  }
  return lines
}

function extractPassages(lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].t.match(/請依下文回答第\s*(\d+)\s*題至第\s*(\d+)\s*題/)
    if (!m) continue
    const from = +m[1], to = +m[2]
    const parts = []
    for (let k = i + 1; k < lines.length; k++) {
      const l = lines[k]
      const isNum = /^\d{1,3}$/.test(l.t)
      const n = +l.t
      if (isNum && l.x < LEFT_MARGIN && n >= from && n <= to) break   // 選項列開始
      if (/^(代號|頁次|座號)/.test(l.t)) continue                      // 頁首頁尾
      if (isNum && n >= from && n <= to) { parts.push(`＿＿(${n})＿＿`); continue }
      parts.push(l.t)
    }
    out.push({ from, to, passage: parts.join(' ').replace(/\s+/g, ' ').trim() })
  }
  return out
}

;(async () => {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  const arr = raw.questions || raw
  const papers = new Map()
  for (const q of arr) {
    if (!q.exam_code || !q.subject) continue
    const k = `${q.exam_code}|${q.subject}`
    if (!papers.has(k)) papers.set(k, [])
    papers.get(k).push(q)
  }

  let done = 0, skipped = 0
  for (const [k, items] of papers) {
    const [code, subject] = k.split('|')
    // 只處理有「題組解析失敗」或題幹明顯不成句的卷，不要動好的資料
    const broken = items.filter(q => q.incomplete === 'cloze_parse_failed' || q.incomplete === 'stem_option_mismatch')
    if (!broken.length) continue

    let lines = null, off = null, ans = {}
    try {
      const cand = await resolvePaper({ exam: EXAM, code, year: items[0]?.roc_year, subject, items })
      if (cand) {
        const b = await fetchSheet('Q', code, cand.c, cand.s)
        if (b) {
          const mupdf = await import('mupdf')
          lines = pageLines(mupdf.Document.openDocument(b, 'application/pdf'), mupdf)
          off = await pdfQuestions(b)
        }
        try { const sb = await fetchSheet('S', code, cand.c, cand.s); if (sb) ans = await parseAnswerSheet(sb) } catch {}
      }
    } catch {}
    if (!lines) { console.log(`  ${code} ${subject}: 抓不到試題卷`); skipped += broken.length; continue }

    const passages = extractPassages(lines)
    if (!passages.length) { console.log(`  ${code} ${subject}: 原卷沒有「請依下文回答第N題」的題組`); skipped += broken.length; continue }

    for (const q of broken) {
      const p = passages.find(x => q.number >= x.from && q.number <= x.to)
      if (!p || p.passage.length < 80) { skipped++; continue }
      // 選項來源有三種優先序：
      //   1. 讀圖還原的 _tmp/vision-broken/answers.json（克漏字的選項行是
      //      「11 (A) once (B) or else …」全擠在一行，pdfQuestions 解析不到，
      //      只能靠讀圖）
      //   2. 原卷解析結果
      //   3. 題庫現有選項（必須本身就乾淨）
      const fromVision = VISION[String(q.id)]
      const src = off && off.get(+q.number)
      const opts = fromVision
        ? { A: fromVision.A, B: fromVision.B, C: fromVision.C, D: fromVision.D }
        : src ? { A: src.options[0], B: src.options[1], C: src.options[2], D: src.options[3] }
        : (q.options || null)
      // 每個題組最後一題的選項 D 常常被「下一個題組的說明」蓋掉
      //（例：D 變成「請依下文回答第」）。這種選項非空又不重複，
      // 一般的乾淨檢查抓不到，但答案如果剛好指向 D 就整題全錯。
      const NOISE = /請依下文回答|閱讀下文|^(代號|頁次|座號)/
      const clean = opts && ['A', 'B', 'C', 'D'].every(x => opts[x] && String(opts[x]).trim() && !NOISE.test(String(opts[x]))) &&
        new Set(['A', 'B', 'C', 'D'].map(x => normText(opts[x]))).size === 4
      const a = ans[+q.number]
      if (!clean || !a || !/^[A-D]$/.test(String(a))) { skipped++; continue }
      console.log(`  ✔ ${code} ${subject} #${q.number}（第 ${p.from}-${p.to} 題組，文章 ${p.passage.length} 字）`)
      if (process.argv.includes('--show')) {
        // 寫入前一定要能看到完整內容——這支工具第一版把後面所有題的選項
        // 和頁碼都吃進文章裡（等於把答案印在題幹上），是印出來才發現的。
        console.log('      ┌─ 題幹 ─────────────')
        const wrapped = `${MARK}${p.passage}`.replace(/(.{88})/g, '$1' + String.fromCharCode(10) + '      │ ')
        console.log('      │ ' + wrapped)
        console.log(`      │ （本題為文章中第 ${q.number} 格）`)
        console.log('      ├─ 選項 ─────────────')
        console.log('      │ ' + ['A', 'B', 'C', 'D'].map(x => `${x}.${opts[x]}`).join('  '))
        console.log(`      └─ 答案 ${a}`)
      }
      if (APPLY) {
        q.question = `${MARK}${p.passage}\n\n（本題為文章中第 ${q.number} 格）`
        q.options = opts
        q.answer = String(a)
        q.explanation = ''
        delete q.incomplete
      }
      done++
    }
  }

  // ⚠️ 真的寫檔。這支第一版漏了這段，回報「已寫入」但檔案沒變——
  //    同一個疏漏在 repair-broken-questions 也犯過一次。
  if (APPLY && done) {
    if (raw.metadata) raw.metadata.last_updated = new Date().toISOString()
    fs.writeFileSync(FILE, JSON.stringify(raw, null, 2) + String.fromCharCode(10))
  }
  console.log(`\n併入文章 ${done} 題，跳過 ${skipped} 題${APPLY ? '（已寫入）' : '（dry-run）'}`)
  warnZero(`${EXAM} 題組文章併入`, done, '該考試沒有題組解析失敗的題，或原卷抓不到文章')
  process.exitCode = summary()
})()
