#!/usr/bin/env node
/**
 * 修復 medlab 題庫殘留 subject_tag。
 *
 * 來源：早期爬蟲遺留的 placeholder tag（paper1/3/4/5/6、molecular、microbiology、
 * clinical_physio_path）汙染。經 audit 確認複合卷 Q1-40 / Q41-80 各對應一個
 * 子科目（已驗證 113-1 樣本，模式穩定）。
 *
 * 重映射規則（subject + number → correct tag）：
 *   臨床血液學與血庫學:      Q1-40=hematology,         Q41-80=blood_bank
 *   臨床血清免疫學與臨床病毒學:  Q1-40=serology,           Q41-80=virology
 *   生物化學與臨床生化學:      Q1-40=biochemistry,       Q41-80=clinical_biochem
 *   醫學分子檢驗學與臨床鏡檢學:  Q1-40=clinical_micro,    Q41-80=molecular_dx (注意反向)
 *   臨床生理學與病理學:        Q1-40=clinical_physiology, Q41-80=pathology
 *   微生物學與臨床微生物學:     all=medical_microbiology
 */
const fs = require('fs')
const path = require('path')
const { atomicWriteJson } = require('./lib/atomic-write')

const FILE = path.resolve(__dirname, '..', 'questions-medlab.json')
const RESIDUAL_TAGS = new Set([
  'paper1', 'paper3', 'paper4', 'paper5', 'paper6',
  'molecular', 'microbiology', 'clinical_physio_path',
])

const SUBJECT_RULES = {
  '臨床血液學與血庫學':       { first: 'hematology',         last: 'blood_bank' },
  '臨床血清免疫學與臨床病毒學':  { first: 'serology',           last: 'virology' },
  '生物化學與臨床生化學':      { first: 'biochemistry',       last: 'clinical_biochem' },
  '醫學分子檢驗學與臨床鏡檢學':  { first: 'clinical_micro',     last: 'molecular_dx' },
  '臨床生理學與病理學':        { first: 'clinical_physiology', last: 'pathology' },
  '微生物學與臨床微生物學':     { first: 'medical_microbiology', last: 'medical_microbiology' },
}

function correctTagFor(subject, number) {
  const rule = SUBJECT_RULES[subject]
  if (!rule) return null
  return number <= 40 ? rule.first : rule.last
}

const data = JSON.parse(fs.readFileSync(FILE, 'utf-8'))
const questions = data.questions

let fixed = 0
const fixesByTag = {}

for (const q of questions) {
  if (!RESIDUAL_TAGS.has(q.subject_tag)) continue
  const correctTag = correctTagFor(q.subject, q.number)
  if (!correctTag) continue
  fixesByTag[q.subject_tag] = (fixesByTag[q.subject_tag] || 0) + 1
  q.subject_tag = correctTag
  fixed++
}

console.log(`✓ 修正 ${fixed} 題殘留 tag`)
for (const [tag, n] of Object.entries(fixesByTag).sort((a,b)=>b[1]-a[1])) {
  console.log(`   ${tag.padEnd(28)} → ${n} 題`)
}

if (fixed > 0) {
  atomicWriteJson(FILE, data)
  console.log(`💾 寫回 ${path.basename(FILE)}`)
} else {
  console.log('（無需修改）')
}
