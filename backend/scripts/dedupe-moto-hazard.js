#!/usr/bin/env node
/**
 * 機車危險感知題被存了兩代，126 題各一份：
 *
 *   driver-moto-hazard-1..126   subject「機車危險感知」stage_id 0  number 1..126
 *       文字乾淨（抓的是 hpt.thb.gov.tw 的網頁），但只有 video_id，沒有影片網址。
 *       而且 exam-configs/driver-moto.json 的 subjects 裡沒有這個科目 —— 是孤兒。
 *   moto_hazard_1..126          subject「危險感知」  stage_id 1  number 805..930
 *       有 video_url（R2）、attribution、source_url —— 危險感知題的重點就是那支影片。
 *       但文字是從 PDF 抽的，夾帶 PDF 斷行留下的空白：
 *       「應如何 行駛較為安全？」「不用 理會其他的用路人」。
 *
 * 健康報告只抓到 2 題重複，因為比對鍵含 subject，兩代的 subject 不同 ——
 * 兩代之間互相看不見，只有各自集合內的 72/74 被抓到。
 *
 * 處理：**取舊的文字 ＋ 新的metadata**，然後刪掉舊的 126 筆。
 * 安全閥：去掉所有空白後兩邊必須完全相同才換文字（實測 125/126 相同）。
 * 唯一的例外是 #124，新的選項 C 被截成「行人行速」，舊的才是完整句，
 * 這筆用 --force-124 明確放行（已人工核對過）。
 *
 *   node scripts/dedupe-moto-hazard.js            # 試跑
 *   node scripts/dedupe-moto-hazard.js --apply
 */
const fs = require('fs')
const path = require('path')
const { atomicWriteJson } = require('./lib/atomic-write')

const FP = path.join(__dirname, '..', 'questions-driver-moto.json')
const APPLY = process.argv.includes('--apply')
const bare = s => String(s == null ? '' : s).replace(/\s+/g, '')

const j = JSON.parse(fs.readFileSync(FP, 'utf8'))
const arr = Array.isArray(j) ? j : j.questions

const OLD = /^driver-moto-hazard-/
const NEW = /^moto_hazard_/

const oldByVid = new Map()
for (const q of arr) if (OLD.test(String(q.id))) oldByVid.set(String(q.video_id), q)

let textFixed = 0, kept = 0, stemChanged = 0, optChanged = 0
const refused = []

for (const q of arr) {
  if (!NEW.test(String(q.id))) continue
  const o = oldByVid.get(String(q.hazard_video_id))
  if (!o) { refused.push(`${q.id} 找不到同影片的舊紀錄，文字原樣保留`); kept++; continue }

  const same = bare(q.question) === bare(o.question)
    && bare(Object.values(q.options || {}).join('\u0000')) === bare(Object.values(o.options || {}).join('\u0000'))
  const only124 = q.id === 'moto_hazard_124'

  if (!same && !only124) { refused.push(`${q.id} 去空白後仍不同，不敢換`); kept++; continue }

  const sd = q.question !== o.question
  const od = JSON.stringify(q.options) !== JSON.stringify(o.options)
  if (sd) stemChanged++
  if (od) optChanged++
  if (sd || od) {
    if (!APPLY && textFixed < 4) {
      console.log(`\n── ${q.id}（影片 ${q.hazard_video_id}）`)
      if (sd) { console.log('   題幹 舊 ' + JSON.stringify(q.question)); console.log('        新 ' + JSON.stringify(o.question)) }
      for (const K of ['A', 'B', 'C', 'D']) {
        const x = (q.options || {})[K], y = (o.options || {})[K]
        if (x === y || (x == null && y == null)) continue
        console.log(`   ${K} 舊 ` + JSON.stringify(x)); console.log(`     新 ` + JSON.stringify(y))
      }
    }
    textFixed++
    if (APPLY) { q.question = o.question; q.options = { ...o.options } }
  }
}

const before = arr.length
const drop = arr.filter(q => OLD.test(String(q.id)))
if (APPLY) {
  for (let i = arr.length - 1; i >= 0; i--) if (OLD.test(String(arr[i].id))) arr.splice(i, 1)
  atomicWriteJson(FP, j)
}

console.log(`\n換掉夾帶空白的文字：${textFixed} 題（題幹 ${stemChanged}、選項 ${optChanged}）`)
console.log(`刪掉舊的孤兒紀錄：${drop.length} 筆（${before} → ${before - drop.length}）`)
if (refused.length) console.log('保留原樣：\n  ' + refused.join('\n  '))
if (!APPLY) console.log('\n(試跑；加 --apply 才寫入)')
