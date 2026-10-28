#!/usr/bin/env node
/**
 * 清掉已經寫進題庫的題組情境裡夾著的頁首／頁尾。
 *
 * repair-ceec-passages.js 第一次跑的時候 parser 還沒接上
 * lib/ceec-page-furniture，所以 1,036 題題組情境裡有 121 題夾著
 * 「第7頁111年學測共17頁社會考」這種版面家具。
 * parser 已經修好（之後重爬不會再有），這支補既有資料。
 *
 * 只動【題組情境】區塊，不碰題幹本體 —— 避免誤傷正文裡真的提到「第5頁」。
 *
 *   node scripts/clean-ceec-page-furniture.js            # dry-run
 *   node scripts/clean-ceec-page-furniture.js --apply
 */
const fs = require('fs')
const path = require('path')
const { stripPageFurniture } = require('./lib/ceec-page-furniture')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const MARK = '【題組情境】'

let total = 0, changed = 0
for (const f of ['questions-gsat.json', 'questions-ast.json']) {
  const fp = path.join(BK, f)
  if (!fs.existsSync(fp)) continue
  const j = JSON.parse(fs.readFileSync(fp, 'utf8'))
  const arr = j.questions || j
  let touched = false

  for (const q of arr) {
    const s = String(q.question || '')
    if (!s.startsWith(MARK)) continue
    total++
    // 只處理題組情境那一段（到第一個雙換行為止），題幹本體不碰
    const sep = s.indexOf('\n\n')
    const head = sep > 0 ? s.slice(0, sep) : s
    const tail = sep > 0 ? s.slice(sep) : ''
    const [cleaned, n] = stripPageFurniture(head)
    if (!n || cleaned === head) continue
    if (cleaned.replace(MARK, '').trim().length < 20) continue   // 清完太短就別動
    changed++
    if (changed <= 6) {
      console.log(`${q.exam_code} ${q.subject} #${q.number}`)
      console.log(`  清掉 ${n} 處，${head.length} → ${cleaned.length} 字`)
    }
    if (APPLY) { q.question = cleaned + tail; touched = true }
  }
  if (touched && APPLY) fs.writeFileSync(fp, JSON.stringify(j, null, 2) + '\n', 'utf8')
}

console.log(`\n題組情境共 ${total} 題，清掉頁首頁尾 ${changed} 題${APPLY ? '' : '（dry-run）'}`)
if (APPLY && changed) console.log('✅ 已寫回')
