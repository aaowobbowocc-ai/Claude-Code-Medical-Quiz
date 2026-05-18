#!/usr/bin/env node
// 掃描選項解析損壞（read-only）。PDF 解析偶爾把某選項換成「鄰近選項的內容」
// （常見：首字母被吃 + 內容變成另一選項的複製）。
//
// 偵測（僅針對長選項 ≥12 字，避免 5mg/15mg、甲狀腺/副甲狀腺 等正常配對誤判）：
//   eaten : 某長選項 = 另一選項去掉第一個字
//   dup   : 兩個長選項完全相同
//
// 用法: node scripts/scan-option-corruption.js [--exam medlab]
const fs = require('fs')
const path = require('path')

const MIN_LEN = 12
const BACKEND = path.join(__dirname, '..')
const examArg = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1]
  || (process.argv.includes('--exam') ? process.argv[process.argv.indexOf('--exam') + 1] : null)

let files = fs.readdirSync(BACKEND).filter(f => /^questions(-[\w-]+)?\.json$/.test(f))
if (examArg) files = files.filter(f => f === `questions-${examArg}.json` || (examArg === 'doctor1' && f === 'questions.json'))

let total = 0
for (const file of files) {
  const data = JSON.parse(fs.readFileSync(path.join(BACKEND, file), 'utf-8'))
  const arr = data.questions || data
  const hits = []
  for (const q of arr) {
    if (!q.options) continue
    const keys = ['A', 'B', 'C', 'D']
    const o = keys.map(k => String(q.options[k] ?? '').trim())
    let reason = null
    for (let x = 0; x < 4 && !reason; x++) for (let y = 0; y < 4 && !reason; y++) {
      // 排除否定詞前綴（「具有」vs「不具有」是正常選項，非解析損壞）
      if (x !== y && o[x].length >= MIN_LEN && o[y].length === o[x].length + 1 && o[y].slice(1) === o[x]
          && !'不非未無'.includes(o[y][0]))
        reason = `${keys[x]} = ${keys[y]} 去首字「${o[y][0]}」`
    }
    if (!reason) for (let i = 0; i < 4 && !reason; i++) for (let j = i + 1; j < 4 && !reason; j++) {
      if (o[i] && o[i].length >= MIN_LEN && o[i] === o[j]) reason = `${keys[i]} = ${keys[j]} 完全相同`
    }
    if (reason) hits.push({ id: q.id, n: q.number, yr: q.roc_year, ses: q.session, subj: q.subject, reason })
  }
  if (hits.length) {
    console.log(`\n=== ${file} (${hits.length}) ===`)
    for (const h of hits) console.log(`  id ${h.id} | ${h.yr}年${h.ses || ''} ${h.subj || ''} #${h.n} | ${h.reason}`)
    total += hits.length
  }
}
console.log(`\n總計：${total} 題選項疑似損壞`)
