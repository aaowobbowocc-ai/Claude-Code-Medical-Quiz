#!/usr/bin/env node
/**
 * Detect shuffled AI explanations:
 * For each question, extract distinctive n-grams from question text + options.
 * If the explanation contains ZERO overlap, the explanation is for a different question.
 *
 * Usage:
 *   node scripts/scan-shuffled-explanations.js          # dry run
 *   node scripts/scan-shuffled-explanations.js --apply  # clear bad explanations
 */
const fs = require('fs')
const path = require('path')

const FILES = [
  'questions.json',
  'questions-doctor2.json',
  'questions-dental1.json',
  'questions-dental2.json',
  'questions-pharma1.json',
  'questions-pharma2.json',
  'questions-medlab.json',
  'questions-pt.json',
  'questions-ot.json',
  'questions-nursing.json',
  'questions-nutrition.json',
]

// Stop tokens — too generic to count as content overlap
const STOP = new Set([
  '下列', '何者', '正確', '錯誤', '何種', '為何', '何項', '說明', '敘述',
  '敘述何', '述何', '相關', '關於', '主要', '功能', '作用', '影響', '機制',
  '可能', '能夠', '應該', '不會', '會發', '不是', '其中', '上述', '以下',
  '臨床', '使用', '治療', '藥物', '患者', '病人', '症狀', '檢查', '結果',
  '需要', '可以', '一般', '常見', '經常', '通常', '組成', '結構', '部分',
  '形成', '產生', '增加', '減少', '降低', '升高', '具有', '包含', '進行',
  '介於', '位於', '發生', '出現', '表現', '反應', '受體', '細胞', '組織',
  '系統', '過程', '時期', '階段', '情況', '狀態', '條件', '基本', '基礎',
  '可能會', '不可能', '英文', '中文', '名稱', '單位', '計算', '估計', '判斷',
])

function extractCJKNgrams(text, n) {
  if (!text) return new Set()
  const clean = text.replace(/[\s，。、；：？！（）()【】「」『』《》"'.,;:?!\[\]{}<>]/g, '')
  const grams = new Set()
  for (let i = 0; i <= clean.length - n; i++) {
    const g = clean.slice(i, i + n)
    // Only pure CJK trigrams
    if (!/^[\u4e00-\u9fff]+$/.test(g)) continue
    if (STOP.has(g)) continue
    grams.add(g)
  }
  return grams
}

function extractTokens(text) {
  if (!text) return new Set()
  const tokens = new Set()
  // English/Latin words 4+ chars (drug names, anatomical terms)
  const words = text.match(/[A-Za-z][A-Za-z\-]{3,}/g) || []
  for (const w of words) tokens.add(w.toLowerCase())
  // Abbreviations / chemical formulas with digits (CO2, IL-1, NF-κB, CD59)
  const abbr = text.match(/[A-Z][A-Z0-9\-]{1,}/g) || []
  for (const a of abbr) tokens.add(a.toLowerCase())
  return tokens
}

function isShuffled(q) {
  if (!q.explanation || !q.question) return false
  // Build keyword pool from question + first ~25 chars of each option
  let qText = q.question
  if (q.options) {
    for (const v of Object.values(q.options)) {
      if (typeof v === 'string') qText += ' ' + v.slice(0, 30)
    }
  }
  const qGrams = extractCJKNgrams(qText, 3)
  const qTokens = extractTokens(qText)
  if (qGrams.size + qTokens.size < 5) return false

  const explNoSpace = q.explanation.replace(/[\s，。、；：？！（）()【】「」『』《》"'.,;:?!\[\]{}<>*\-]/g, '')
  const explLower = q.explanation.toLowerCase()

  let hits = 0
  for (const g of qGrams) {
    if (explNoSpace.includes(g)) hits++
    if (hits >= 2) return false
  }
  for (const t of qTokens) {
    if (explLower.includes(t)) hits++
    if (hits >= 2) return false
  }
  return hits < 2
}

let totalSuspicious = 0
const dryRun = !process.argv.includes('--apply')

for (const f of FILES) {
  const fp = path.join(__dirname, '..', f)
  if (!fs.existsSync(fp)) continue
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
  const qs = data.questions || data
  const suspicious = []
  for (const q of qs) {
    if (isShuffled(q)) suspicious.push(q)
  }
  if (suspicious.length === 0) {
    console.log(`${f}: 0`)
    continue
  }
  console.log(`${f}: ${suspicious.length} suspicious`)
  for (const q of suspicious.slice(0, 5)) {
    console.log(`  ${q.id} (ans=${q.answer}): ${q.question.slice(0, 50)}`)
  }
  totalSuspicious += suspicious.length
  if (!dryRun) {
    for (const q of suspicious) q.explanation = ''
    const out = data.questions ? data : qs
    fs.writeFileSync(fp, JSON.stringify(out, null, 2) + '\n')
    console.log(`  → cleared ${suspicious.length}`)
  }
}
console.log(`\nTotal suspicious: ${totalSuspicious}`)
console.log(dryRun ? '(dry run — pass --apply to clear)' : '(applied)')
