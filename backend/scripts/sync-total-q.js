#!/usr/bin/env node
/**
 * 把每個 exam-config 的 totalQ + seo.totalQ 同步到實際 questions JSON 數量。
 * 同時更新 frontend snapshot。輸出全站合計題數，給 SEO 文案用。
 */
const fs = require('fs')
const path = require('path')
const { atomicWriteJson } = require('./lib/atomic-write')

const BACKEND = path.resolve(__dirname, '..')
const FRONTEND_SNAPSHOT = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'exam-configs-snapshot')
const CONFIG_DIR = path.join(BACKEND, 'exam-configs')

let siteTotal = 0
const updates = []

for (const file of fs.readdirSync(CONFIG_DIR).filter(f => f.endsWith('.json'))) {
  const cfgPath = path.join(CONFIG_DIR, file)
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
  let actual
  if (cfg.questionsFile) {
    const qPath = path.join(BACKEND, cfg.questionsFile)
    if (!fs.existsSync(qPath)) continue
    const data = JSON.parse(fs.readFileSync(qPath, 'utf-8'))
    actual = (data.questions || data).length
    siteTotal += actual
  } else if ((cfg.sharedBanks || []).length) {
    // 公職／司法的 shell 考試沒有自己的題庫檔，題目全部來自共用題庫。
    // 這裡原本直接 continue，於是共用題庫補題之後那幾張卡的題數永遠停在舊值
    //（civil-senior-general 停在 2475、judicial 停在 908）。
    // 前端是依 level 篩共用題庫的，這裡用同一條件算。
    const level = { level_3_common: 'senior', level_4_common: 'junior', level_5_common: 'elementary' }[cfg.sharedScope]
    actual = 0
    for (const b of cfg.sharedBanks) {
      const p = path.join(BACKEND, 'shared-banks', b + '.json')
      if (!fs.existsSync(p)) continue
      const bank = JSON.parse(fs.readFileSync(p, 'utf-8'))
      actual += (bank.questions || []).filter(q => !level || q.level === level).length
    }
    // 共用題庫會被好幾個考試共用，重複加進全站合計會灌水，所以不計入 siteTotal
  } else continue

  let changed = false
  if (cfg.totalQ !== actual) {
    updates.push({ file, field: 'totalQ', from: cfg.totalQ, to: actual })
    cfg.totalQ = actual
    changed = true
  }
  if (cfg.seo && cfg.seo.totalQ !== undefined && cfg.seo.totalQ !== actual) {
    updates.push({ file, field: 'seo.totalQ', from: cfg.seo.totalQ, to: actual })
    cfg.seo.totalQ = actual
    changed = true
  }
  if (changed) {
    atomicWriteJson(cfgPath, cfg)
    // mirror to frontend snapshot
    const snapPath = path.join(FRONTEND_SNAPSHOT, file)
    if (fs.existsSync(snapPath)) atomicWriteJson(snapPath, cfg)
  }
}

console.log(`✓ ${updates.length} 處更新`)
for (const u of updates.slice(0, 30)) {
  console.log(`   ${u.file.padEnd(25)} ${u.field.padEnd(12)} ${u.from} → ${u.to}`)
}
if (updates.length > 30) console.log(`   ... 還有 ${updates.length - 30}`)
console.log(``)
console.log(`📊 全站合計：${siteTotal.toLocaleString()} 題`)
