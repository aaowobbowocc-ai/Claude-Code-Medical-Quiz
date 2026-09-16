#!/usr/bin/env node
/**
 * 修 pharma1（藥師一階）106~109 年「卷一整卷是卷三的複製品」。
 *
 * 怎麼發現的：掃更正答案時，這 8 場的卷一怎麼都反查不到科目。追下去才發現
 * 卷一存的題目其實是藥劑學（卷三）的內容——同場次兩卷 98~99% 相同，
 * 而真正的「藥理學與藥物化學」整卷從來沒進題庫。640 題假題就這樣躺了很久，
 * 任何「缺題盤點」都看不出來，因為題數是滿的。
 *
 * 修法：不刪列、就地覆寫。
 *   刪掉再新增會換掉 question id，使用者的錯題夾／作答紀錄會整批失聯。
 *   所以照題號一對一把內容換成真正的卷一，id 原封不動。
 *   subject_tag 保留原本的（1-40 藥理學、41-80 藥物化學），那本來就對。
 *
 * 用法：
 *   node scripts/fix-pharma1-vol1-duplicates.js            # dry-run
 *   node scripts/fix-pharma1-vol1-duplicates.js --apply
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { fetchSheet } = require('./lib/moex-paper-resolve')
const { pdfQuestions } = require('./lib/moex-pdf-parse')
const { parseAnswerSheet } = require('./lib/moex-answer-sheet')
const { skeleton } = require('./lib/moex-normalize')
const { warnZero, summary } = require('./lib/coverage-guard')

const APPLY = process.argv.includes('--apply')
// 重跑用：第一次重建時選項解析得不乾淨（連「A.」一起存進去），需要覆蓋已重建過的卷
const FORCE = process.argv.includes('--force')
const FILE = path.join(__dirname, '..', 'questions-pharma1.json')
const UA = 'Mozilla/5.0'
const REF = 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx'

// 8 場都是 c=305 s=11（藥理學與藥物化學），由 lib/moex-paper-resolve 反查並確認
// 與卷三 0 題重疊後寫死在這裡。
const TARGETS = ['106020', '106100', '107020', '107100', '108030', '108100', '109020', '109100']
  .map(code => ({ code, c: '305', s: '11' }))

async function main() {
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  const arr = data.questions || data
  let replaced = 0, sessions = 0

  for (const t of TARGETS) {
    const rows = arr.filter(q => String(q.exam_code) === t.code && q.subject === '卷一')
    if (!rows.length) { console.log(`  ${t.code}: 找不到卷一列，跳過`); continue }

    const vol3 = arr.filter(q => String(q.exam_code) === t.code && q.subject === '卷三')
      .map(q => skeleton(q.question).slice(0, 25))
    const dupRate = rows.filter(q => vol3.includes(skeleton(q.question).slice(0, 25))).length / rows.length
    // 只動確定是複製品的卷。萬一哪天有人已經補對了，這裡要自動跳過而不是覆蓋掉。
    if (dupRate < 0.8 && !FORCE) { console.log(`  ${t.code}: 與卷三重複率僅 ${(dupRate * 100).toFixed(0)}%，不是複製品，跳過`); continue }

    const qBuf = await fetchSheet('Q', t.code, t.c, t.s)
    if (!qBuf) { console.log(`  ${t.code}: 試題 PDF 抓不到`); continue }
    const aBuf = await fetchSheet('S', t.code, t.c, t.s)
    const byNum = await pdfQuestions(qBuf)
    let answers = {}
    if (aBuf) { try { answers = await parseAnswerSheet(aBuf) } catch {} }
    const parsed = [...byNum.values()]

    let n = 0, stranded = 0
    for (const row of rows) {
      const src = byNum.get(row.number)
      const ans = answers[row.number]
      const o = src ? { A: src.options[0], B: src.options[1], C: src.options[2], D: src.options[3] } : {}
      // 選項不能再帶「A.」開頭，也不能是空的——否則等於把壞資料寫進題庫
      const clean = ['A', 'B', 'C', 'D'].every(k => o[k] && o[k].trim().length >= 1 && !/^[A-D]\s*[.．、]/.test(o[k]))
      const ok = src && ans && /^[ABCD]$/.test(ans) && clean
      if (!ok) {
        // 換不過來的（多半是化學結構式那種選項全是圖的題）不能就這樣放著——
        // 留著的是卷三的內容，比缺題更糟。標成不完整讓前端隱藏。
        stranded++
        if (APPLY) row.incomplete = 'wrong_source_paper'
        continue
      }
      if (APPLY) {
        row.question = String(src.stem).replace(/^[\s.．、]+/, '')
        row.options = { A: o.A, B: o.B, C: o.C, D: o.D }
        row.answer = ans
        row.explanation = ''          // 舊解說是在解釋藥劑學的題目，留著只會誤導
        delete row.disputed           // 爭議標記屬於舊（錯的）題目
        delete row.incomplete
      }
      n++
    }
    console.log(`  ${t.code}: 解析 ${parsed.length} 題／答案 ${Object.keys(answers).length} 筆 → 覆寫 ${n}/${rows.length}` +
      (stranded ? `（${stranded} 題換不過來，標記 incomplete）` : ''))
    replaced += n
    if (n) sessions++
  }

  console.log(`\n共 ${sessions} 場、${replaced} 題${APPLY ? '已覆寫' : '可覆寫（dry-run）'}`)
  warnZero('pharma1 卷一重建', replaced, '8 場的卷一都已不是複製品，或試題 PDF 抓不到')
  if (APPLY && replaced) {
    if (data.total !== undefined) data.total = arr.length
    if (data.metadata) data.metadata.last_updated = new Date().toISOString()
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n')
    console.log('✅ 已寫回 questions-pharma1.json')
  }
  process.exitCode = summary()
}
main().catch(e => { console.error(e); process.exit(1) })
