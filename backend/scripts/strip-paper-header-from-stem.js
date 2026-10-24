#!/usr/bin/env node
/**
 * 切掉黏在題幹前面的試卷表頭。
 *
 *   「小時 座號：※注意：①本試題為單一選擇題…禁止使用電子計算器。 3歲的小明左側鼓膜裝有通氣管…」
 *                                                              ↑ 真正的題幹從這裡開始
 *
 * 只發生在各科第 1 題（表頭在第一頁、緊接著第一題）。
 * 判準不是猜：表頭一定以「禁止使用電子計算器。」或「不予計分。」收尾，
 * 在**最後一個**收尾標記處切，切完的頭要含表頭關鍵字、尾要 ≥10 字。
 * 兩個條件有一個不成立就不動。
 *
 *   node scripts/strip-paper-header-from-stem.js            # dry-run
 *   node scripts/strip-paper-header-from-stem.js --apply
 */
const fs = require('fs')
const path = require('path')
const { atomicWriteJson } = require('./lib/atomic-write')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const HEAD = /座號|※\s*注意|代號[：:]\s*\d|頁次[：:]\s*\d|考試時間[：:]|禁止使用電子計算/
const END = /(?:禁止使用電子計算器。|不予計分。|依題號清楚劃記。)/g

let fixed = 0, skipped = 0
for (const f of fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f))) {
  const exam = f.replace(/questions-?|\.json/g, '') || 'doctor1'
  const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'))
  const arr = j.questions || j
  let touched = false
  for (const q of arr) {
    const s = String(q.question || '')
    if (!HEAD.test(s)) continue
    let cut = -1, m
    END.lastIndex = 0
    while ((m = END.exec(s)) !== null) cut = m.index + m[0].length
    const head = cut > 0 ? s.slice(0, cut) : ''
    const tail = cut > 0 ? s.slice(cut).trim() : ''
    if (!HEAD.test(head) || tail.length < 10) {
      skipped++
      console.log(`⊘ ${exam} ${q.exam_code} ${q.subject} #${q.number} 切不出乾淨的頭尾，留著`)
      console.log(`   ${s.replace(/\s+/g, ' ').slice(0, 100)}`)
      continue
    }
    console.log(`${exam} ${q.exam_code} ${q.subject} #${q.number}`)
    console.log(`   切掉: ${head.replace(/\s+/g, ' ').slice(0, 72)}…`)
    console.log(`   保留: ${tail.replace(/\s+/g, ' ').slice(0, 72)}`)
    if (APPLY) q.question = tail
    fixed++; touched = true
  }
  if (touched && APPLY) atomicWriteJson(path.join(BK, f), j)
}
console.log(`\n切 ${fixed} 題｜留著 ${skipped} 題${APPLY ? '' : '（dry-run）'}`)
if (APPLY && fixed) console.log('✅ 已寫回')
