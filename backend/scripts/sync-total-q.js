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
  if (!cfg.questionsFile) continue
  const qPath = path.join(BACKEND, cfg.questionsFile)
  if (!fs.existsSync(qPath)) continue
  const data = JSON.parse(fs.readFileSync(qPath, 'utf-8'))
  const actual = (data.questions || data).length
  siteTotal += actual

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
