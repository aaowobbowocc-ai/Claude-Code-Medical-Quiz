#!/usr/bin/env node
/**
 * 套用一份人工核對過的「整筆紀錄修正表」。
 *
 * 跟 apply-option-patch.js 的差別：那支只改題幹／選項／旗標，這支連 number 與
 * answer 都能改 —— 因為有一種壞法是**題號解析錯**，而學測／分科的答案是用題號
 * 去答案卷查的（scrape-ceec 的 buildQuestions: answerMap[pq.num]），所以題號一錯，
 * 那題的答案就一定是別題的答案。改答案是重的事，所以：
 *
 *   · key 用 id（不是 code+number —— 題號本身就是壞的，不能當 key）
 *   · 每一筆都要寫 why，而且 why 要寫到「官方答案卷怎麼說」「內容怎麼驗算」
 *   · 試跑一定印新舊並排（見 [[procedure_verify_before_commit]]）
 *
 *   node scripts/apply-record-patch.js _tmp/patch.json
 *   node scripts/apply-record-patch.js _tmp/patch.json --apply
 */
const fs = require('fs')
const path = require('path')
const { atomicWriteJson } = require('./lib/atomic-write')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const PATCH = process.argv.find(a => !a.startsWith('--') && /\.json$/.test(a) && !/apply-record-patch/.test(a))
if (!PATCH) { console.error('用法: node scripts/apply-record-patch.js <patch.json> [--apply]'); process.exit(1) }

const patch = JSON.parse(fs.readFileSync(PATCH, 'utf8'))
const byFile = new Map()
for (const p of patch) {
  if (!byFile.has(p.file)) byFile.set(p.file, [])
  byFile.get(p.file).push(p)
}

// ⚠️ JSON.stringify(undefined) 回傳的是 undefined 本身，不是字串 —— 直接 .slice 會炸。
// 新增一個原本沒有的選項（例如補上 (E)）就會走到這裡。
const short = v => (v == null ? String(v) : JSON.stringify(String(v).replace(/\s+/g, ' ')).slice(0, 100))
let changed = 0, skipped = 0

for (const [file, items] of byFile) {
  const fp = path.join(BK, file)
  const j = JSON.parse(fs.readFileSync(fp, 'utf8'))
  const arr = Array.isArray(j) ? j : j.questions
  let dirty = false

  for (const p of items) {
    const hits = arr.filter(q => String(q.id) === String(p.id))
    if (hits.length !== 1) { console.log(`✗ ${file} id=${p.id} 對到 ${hits.length} 筆，跳過`); skipped++; continue }
    const q = hits[0]

    console.log(`\n── ${file} id=${p.id}`)
    console.log('   · ' + p.why)
    for (const [k, v] of Object.entries(p.set)) {
      if (k === 'options') {
        for (const K of ['A', 'B', 'C', 'D', 'E']) {
          const a = (q.options || {})[K], b = v[K]
          if (a === b || (a == null && b == null)) continue
          console.log(`   選項 ${K} 舊 ${short(a)}`)
          console.log(`          新 ${short(b)}`)
        }
      } else if (String(q[k]) !== String(v)) {
        console.log(`   ${k} 舊 ${short(q[k])}`)
        console.log(`   ${' '.repeat(k.length)} 新 ${short(v)}`)
      }
    }

    if (APPLY) {
      for (const [k, v] of Object.entries(p.set)) q[k] = (k === 'options') ? { ...v } : v
      dirty = true
    }
    changed++
  }
  if (APPLY && dirty) atomicWriteJson(fp, j)
}

console.log(`\n${APPLY ? '已套用 ' : '可套用 '}${changed} 筆${skipped ? `｜跳過 ${skipped}` : ''}`)
if (!APPLY) console.log('(試跑；加 --apply 才寫入)')
