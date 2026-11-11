#!/usr/bin/env node
/**
 * 刪掉標了 `incomplete: "duplicate_record"` 的重複紀錄。
 *
 * 這些題同卷同科目還有一筆題幹一字不差的雙胞胎，而雙胞胎沒有被標、內容也完整。
 * 標了 incomplete 只是把它藏起來，資料還在，之後每次稽核都要重看一遍。
 *
 * tcm2 那幾筆看得出成因：id 是 `102110_0204_15`、`102110_0204_44`、`102110_0204_71`——
 * 尾數正好是題幹開頭「15歲女性患者」「44歲男性患者」「71歲女性患者」的**年齡**。
 * 解析器把年齡當成題號，於是多生出一筆，選項還黏到別題的
 * （#7 的選項變成六君子湯／歸脾湯那一組，正解那筆才是心虛膽怯／肝氣鬱結）。
 * 跟 ast 114 物理「9.8 被當題號」、audiologist 103100「25 個子音被當題號」同一家族。
 *
 * 安全閥（每一筆都要過，過不了就跳過並印出原因）：
 *   1. 同卷同科目找得到題幹相同的另一筆
 *   2. 那一筆沒有被標 incomplete
 *   3. 兩筆答案相同
 * 選項不同是允許的 —— 重複的那筆選項往往是壞的，那正是該刪的理由。
 *
 *   node scripts/drop-duplicate-records.js
 *   node scripts/drop-duplicate-records.js --apply
 */
const fs = require('fs')
const path = require('path')
const { skeleton } = require('./lib/moex-normalize')
const { atomicWriteJson } = require('./lib/atomic-write')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const norm = s => skeleton(String(s == null ? '' : s))

let drop = 0, skip = 0
for (const f of fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f) && !/\.bak/.test(f))) {
  const fp = path.join(BK, f)
  const j = JSON.parse(fs.readFileSync(fp, 'utf8'))
  const arr = Array.isArray(j) ? j : j.questions
  if (!arr) continue
  const exam = f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '')
  const kill = new Set()

  for (const q of arr) {
    if (q.incomplete !== 'duplicate_record') continue
    const twins = arr.filter(x => x !== q && !kill.has(x)
      && String(x.exam_code) === String(q.exam_code) && String(x.subject) === String(q.subject)
      && norm(x.question) === norm(q.question) && norm(q.question).length >= 10)
    const keep = twins.find(t => !t.incomplete && t.answer === q.answer)
    if (!keep) {
      skip++
      console.log(`✗ ${exam} ${q.id} #${q.number}：找不到「沒被標、答案相同」的雙胞胎（同文 ${twins.length} 筆），留著`)
      continue
    }
    const optSame = JSON.stringify(['A', 'B', 'C', 'D'].map(k => norm((q.options || {})[k])))
      === JSON.stringify(['A', 'B', 'C', 'D'].map(k => norm((keep.options || {})[k])))
    console.log(`${exam} 刪 ${q.id}(#${q.number}) → 保留 ${keep.id}(#${keep.number})　答 ${q.answer}　選項${optSame ? '相同' : '不同（刪的那筆是壞的）'}`)
    console.log(`   ${String(q.question).replace(/\s+/g, ' ').slice(0, 72)}`)
    kill.add(q)
    drop++
  }

  if (APPLY && kill.size) {
    for (let i = arr.length - 1; i >= 0; i--) if (kill.has(arr[i])) arr.splice(i, 1)
    atomicWriteJson(fp, j)
  }
}

console.log(`\n${APPLY ? '已刪 ' : '可刪 '}${drop} 筆${skip ? `｜跳過 ${skip}` : ''}`)
if (!APPLY) console.log('(試跑；加 --apply 才寫入)')
