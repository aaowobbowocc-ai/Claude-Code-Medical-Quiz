#!/usr/bin/env node
// 2 行政學 questions wrongly stored in common_english.json with English-style IDs
// Move them to common_admin_studies.json with proper ID
const fs = require('fs')
const path = require('path')

const enPath = 'shared-banks/common_english.json'
const adminPath = 'shared-banks/common_admin_studies.json'
const enData = JSON.parse(fs.readFileSync(enPath, 'utf-8'))
const adminData = JSON.parse(fs.readFileSync(adminPath, 'utf-8'))
const enArr = enData.questions || enData
const adminArr = adminData.questions || adminData

const misIds = ['common_english-113-civil-senior-23', 'common_english-112-civil-senior-21']
const moved = []
for (const id of misIds) {
  // Find the 行政學 (non-English) one
  const idx = enArr.findIndex(q => q.id === id && q.subject === '行政學')
  if (idx < 0) { console.log('not found in en:', id); continue }
  const q = enArr.splice(idx, 1)[0]
  // Rename ID to admin_studies pattern
  q.id = id.replace('common_english', 'common_admin_studies')
  adminArr.push(q)
  moved.push(q.id)
  console.log('moved:', id, '→', q.id)
}
fs.writeFileSync(enPath, JSON.stringify(enData, null, 2))
fs.writeFileSync(adminPath, JSON.stringify(adminData, null, 2))
console.log('Moved:', moved.length)
