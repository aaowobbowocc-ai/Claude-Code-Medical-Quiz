#!/usr/bin/env node
/**
 * 修「閱讀測驗／克漏字題組」解析失敗造成的兩種損壞。
 *
 * 考選部把題組寫成「請依下文回答第31題至35題：<文章>」夾在上一題與下一題之間，
 * 解析器抓不到這個結構時會出兩種錯：
 *
 *   (a) 那段說明＋文章被接到**上一題最後一個選項**的尾巴。
 *       例：警察 107070 #30 選項 D =「…但不得減少其勞動條件請依下文回答第31題至35題：Mo…」
 *       → 可以安全修：截掉標記以後的內容。
 *
 *   (b) 題組裡的每一題都被填成**同一題**的內容（題幹、選項、答案全同）。
 *       例：警察 107070 #31~36 六題都是「Which of the following best describes the tone…」
 *       → 無法判斷哪一題才是對的（官方卷這種版型解析不出來），
 *         所以整組標 incomplete 讓前端隱藏。寧可少題，也不要讓使用者連看五題一樣的。
 *
 * 用法：
 *   node scripts/fix-cloze-damage.js            # dry-run
 *   node scripts/fix-cloze-damage.js --apply
 */
const fs = require('fs')
const path = require('path')
const { skeleton } = require('./lib/moex-normalize')
const { warnZero, summary } = require('./lib/coverage-guard')

const APPLY = process.argv.includes('--apply')
const DIR = path.join(__dirname, '..')
// 題組說明的起頭。中英文卷都有。
const LEAK = /(請依下文回答第|請依下文回答|閱讀下文，?回答第|依下文回答第|Questions?\s*\d+\s*[-–]\s*\d+\s*(?:are based|refer))/

let fixedLeak = 0, markedDup = 0
const files = fs.readdirSync(DIR).filter(f => /^questions(-.*)?\.json$/.test(f) && !/\.bak/.test(f))

for (const f of files) {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))
  const arr = Array.isArray(raw) ? raw : raw.questions
  if (!arr) continue
  let touched = 0

  // (a) 選項尾巴的題組說明
  for (const q of arr) {
    for (const k of ['A', 'B', 'C', 'D']) {
      const v = (q.options || {})[k]
      if (typeof v !== 'string') continue
      const m = v.match(LEAK)
      if (!m) continue
      const cut = v.slice(0, m.index).trim()
      if (cut.length < 2) {
        // 整個選項就是那段說明（關務 109050 #15 題幹只剩 "lasted"、選項D 只有
        // 「請依下文回答第」）——整題都毀了，沒東西可截，標 incomplete。
        console.log(`  [全毀] ${f} ${q.exam_code} ${q.subject} #${q.number} 選項${k} 整個是題組說明 → 標 incomplete`)
        if (APPLY) q.incomplete = 'cloze_parse_failed'
        markedDup++; touched++
        continue
      }
      console.log(`  [尾巴] ${f} ${q.exam_code} ${q.subject} #${q.number} 選項${k}: 截掉 ${v.length - cut.length} 字`)
      if (APPLY) q.options[k] = cut
      fixedLeak++; touched++
    }
  }

  // (b) 同卷內題幹＋選項完全相同 → 整組標 incomplete
  const groups = new Map()
  for (const q of arr) {
    if (!q.exam_code || !q.subject) continue
    const key = `${q.exam_code}|${q.subject}||` + skeleton(q.question) + '||' +
      ['A', 'B', 'C', 'D'].map(x => skeleton((q.options || {})[x] || '')).join('|')
    if (skeleton(q.question).length < 8) continue     // 題幹太短另有問題，不在這裡處理
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(q)
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue
    const nums = list.map(q => q.number).join(',')
    console.log(`  [題組] ${f} ${list[0].exam_code} ${list[0].subject} #${nums} 共 ${list.length} 題內容完全相同 → 標 incomplete`)
    for (const q of list) {
      if (APPLY) q.incomplete = 'cloze_parse_failed'
      markedDup++; touched++
    }
  }

  if (APPLY && touched) {
    if (raw.metadata) raw.metadata.last_updated = new Date().toISOString()
    fs.writeFileSync(path.join(DIR, f), JSON.stringify(raw, null, 2) + '\n')
  }
}

console.log(`\n選項尾巴修正 ${fixedLeak} 處，題組重複標記 ${markedDup} 題${APPLY ? '（已寫入）' : '（dry-run）'}`)
warnZero('題組損壞修復', fixedLeak + markedDup, '掃不到損壞，或 regex 沒涵蓋到新的題組說明寫法')
process.exitCode = summary()
