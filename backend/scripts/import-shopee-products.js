#!/usr/bin/env node
/**
 * 匯入蝦皮分潤後台批量匯出的「商品 CSV」 → break-lounge-products.json
 *
 * 蝦皮商品 CSV 欄位（推測，實際以匯出檔為準）：
 *   推廣計畫名稱(商品名),推廣效期,分潤率,推廣連結,推廣短連結,圖片URL?,售價?
 *
 * 腳本會自動偵測：
 *   - 商品名 = 第 1 欄
 *   - 短連結 = 最後一欄看起來像 https://s.shopee.tw/... 的欄位
 *   - 圖片 = 任何含 https://...jpg/png/webp 的欄位
 *   - 價格 = 含 "$" 或 "NT" 的欄位
 *
 * 若 CSV 格式跟 import-shopee-shops.js 完全一樣（沒圖沒價）也能跑，只是揭曉卡只顯示商品名。
 */

const fs = require('fs')
const path = require('path')

const CSV_PATHS = process.argv.slice(2)
const JSON_PATH = path.join(__dirname, '..', '..', 'frontend', 'public', 'break-lounge-products.json')

if (!CSV_PATHS.length || CSV_PATHS.some(p => !fs.existsSync(p))) {
  console.error('用法: node import-shopee-products.js <CSV 檔案 1> [CSV 檔案 2] ...')
  process.exit(1)
}

function parseCSV(text) {
  const rows = []
  let row = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"') { inQuotes = false }
      else { cur += c }
    } else {
      if (c === '"') { inQuotes = true }
      else if (c === ',') { row.push(cur); cur = '' }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = '' }
      else if (c === '\r') { /* skip */ }
      else { cur += c }
    }
  }
  if (cur || row.length) { row.push(cur); rows.push(row) }
  return rows
}

let allRows = []
let header = null
for (const p of CSV_PATHS) {
  const csvText = fs.readFileSync(p, 'utf8').replace(/^﻿/, '')
  const rows = parseCSV(csvText)
  if (!header && rows[0]) header = rows[0].map(s => s.trim())
  const dataRows = rows.filter(r => r.length >= 2 && r[0] && r[0] !== header[0])
  console.log(`${path.basename(p)}: ${dataRows.length} 筆`)
  allRows = allRows.concat(dataRows)
}
console.log(`合計：${allRows.length} 筆`)
console.log(`Header: ${header ? header.join(' | ') : '(未知)'}`)

// 自動偵測欄位 index — 優先用 header 名稱，再 fallback 到 value sniffing
function findHeaderCol(...keywords) {
  if (!header) return -1
  return header.findIndex(h => keywords.some(k => h.includes(k)))
}
function findValueCol(rows, predicate) {
  if (!rows.length) return -1
  const ncol = Math.max(...rows.map(r => r.length))
  for (let c = 0; c < ncol; c++) {
    const samples = rows.slice(0, 10).map(r => r[c] || '').filter(Boolean)
    if (samples.length && samples.every(predicate)) return c
  }
  return -1
}

let nameIdx = findHeaderCol('商品名稱', '商品名', '推廣計畫名稱', '名稱')
if (nameIdx < 0) nameIdx = 0

let urlIdx = findHeaderCol('推廣短連結', '推廣連結', '短連結')
if (urlIdx < 0) urlIdx = findValueCol(allRows, v => /^https:\/\/s\.shopee\.tw\//.test(v.trim()))
if (urlIdx < 0) urlIdx = findValueCol(allRows, v => /^https:\/\/shopee\.tw\//.test(v.trim()))

let imgIdx = findHeaderCol('商品圖片', '圖片', 'image')
if (imgIdx < 0) imgIdx = findValueCol(allRows, v => /^https:\/\/.+\.(jpg|jpeg|png|webp)/i.test(v.trim()))

let priceIdx = findHeaderCol('商品價格', '售價', '價格')
if (priceIdx < 0) priceIdx = findValueCol(allRows, v => /\$|NT|TWD/i.test(v))

console.log(`偵測欄位 → 名稱[${nameIdx}] 短連結[${urlIdx}] 圖片[${imgIdx}] 價格[${priceIdx}]`)

if (urlIdx < 0) {
  console.error('找不到短連結欄位（https://s.shopee.tw/... 或 https://shopee.tw/...）')
  process.exit(1)
}

// 追加合併：保留現有商品，用短連結去重，只加新的
let existing = []
try {
  const prev = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'))
  existing = prev.sections?.[0]?.products || []
} catch { /* 檔案不存在 → 從空開始 */ }

const seen = new Set(existing.map(p => p.shopUrl))
const added = []
for (const r of allRows) {
  const name = (r[nameIdx] || '').trim()
  const shopUrl = (r[urlIdx] || '').trim()
  if (!name || !shopUrl || seen.has(shopUrl)) continue
  seen.add(shopUrl)
  const item = { name, shopUrl, ctaText: '看看這個商品' }
  if (imgIdx >= 0 && r[imgIdx]) item.image = r[imgIdx].trim()
  if (priceIdx >= 0 && r[priceIdx]) {
    const raw = r[priceIdx].trim()
    item.price = /^[\d,]+$/.test(raw) ? `NT$${raw}` : raw
  }
  added.push(item)
}
const products = existing.concat(added)
console.log(`現有 ${existing.length} 個 + 新增 ${added.length} 個 = ${products.length} 個商品`)

const data = {
  intro: '',
  sections: [
    { id: 'products', icon: '🎁', title: '商品池', products },
  ],
}

fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8')
console.log(`已寫入 ${JSON_PATH}`)
