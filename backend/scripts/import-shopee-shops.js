#!/usr/bin/env node
/**
 * 匯入蝦皮分潤後台批量匯出的 CSV → break-lounge.json
 * CSV schema: 推廣計畫名稱,推廣效期,分潤率,推廣連結,推廣短連結
 * 原本 6 家保留，新增一個「雜貨間隨便逛」section 塞所有 CSV 店家。
 */

const fs = require('fs')
const path = require('path')

const CSV_PATHS = process.argv.slice(2)
const JSON_PATH = path.join(__dirname, '..', '..', 'frontend', 'public', 'break-lounge.json')

if (!CSV_PATHS.length || CSV_PATHS.some(p => !fs.existsSync(p))) {
  console.error('用法: node import-shopee-shops.js <CSV 檔案 1> [CSV 檔案 2] ...')
  process.exit(1)
}

// 簡易 CSV parser（支援多行雙引號值）
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
for (const p of CSV_PATHS) {
  const csvText = fs.readFileSync(p, 'utf8').replace(/^﻿/, '')
  const rows = parseCSV(csvText).filter(r => r.length >= 5 && r[0] && r[0] !== '推廣計畫名稱')
  console.log(`${path.basename(p)}: ${rows.length} 筆`)
  allRows = allRows.concat(rows)
}
const rows = allRows
console.log(`合計：${rows.length} 筆`)

// 去重 by 短連結
const seen = new Set()
const products = []
for (const r of rows) {
  const name = r[0].trim()
  const shopUrl = r[4].trim()
  if (!name || !shopUrl || seen.has(shopUrl)) continue
  seen.add(shopUrl)
  products.push({ name, blurb: '', shopUrl, ctaText: '進入店家頁面' })
}
console.log(`去重後：${products.length} 家`)

// 直接覆寫：原本 6 家不用了，整個 pool 就是這 200 家
const data = {
  intro: '',
  sections: [
    {
      id: 'shops',
      icon: '🛍️',
      title: '隨便逛逛',
      products,
    },
  ],
}

fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8')
console.log(`已寫入 ${JSON_PATH}：${products.length} 家店`)
