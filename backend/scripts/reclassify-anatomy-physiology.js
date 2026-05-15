#!/usr/bin/env node
// Targeted reclassification: doctor1 questions wrongly tagged physiology
// but contain strong anatomy markers. Conservative — only re-tags when
// signal is unambiguous (e.g., "白質", "神經叢", "韌帶", etc.).
const fs = require('fs')

const STRONG_ANATOMY = [
  /白質/, /灰質/, /神經叢/, /韌帶/, /肌腱/, /肌間/,
  /冠狀韌帶|圓韌帶|十字韌帶/,
  /經過.*三角/, // 枕三角, 鎖骨三角 etc.
  /附著於.*骨/,
  /(動脈|靜脈|淋巴).*分支/,
  /(動脈|靜脈).*供應/,
  /神經.*支配/,
  /大腦.*[葉腦]/, /小腦.*[葉腦]/, /腦幹/, /延腦/,
  /椎間|椎骨|關節/,
  /(下列|何者).*構造/,
  /(下列何者).*伴行/,
  /大[綱動]靜脈|主動脈|腔靜脈/,
  /神經根|神經幹|神經元軸索/,
  /括約肌|平滑肌.*位置/,
  /淋巴結|淋巴管/,
  /corpus callosum|fasciculus|ganglion|plexus|tract.*位於/,
  /中腦|間腦|延髓|橋腦/,
]

const STRONG_PHYSIOLOGY = [
  /(機制|機轉)/,
  /分泌.*荷爾蒙|釋放.*激素/,
  /(收縮|舒張).*力/,
  /細胞.*分泌/,
  /(滲透壓|電位|離子.*通道)/,
  /(心輸出量|腎絲球過濾|肺活量)/,
  /(動作電位|終板電位)/,
  /(代償|失調|穩態)/,
  /酸鹼平衡|電解質平衡/,
  /(吸收|排泄|過濾).*速率/,
]

function strongMatch(text, patterns) {
  for (const p of patterns) if (p.test(text)) return true
  return false
}

const data = JSON.parse(fs.readFileSync('questions.json', 'utf-8'))
const arr = data.questions || data

let anaToPhy = 0, phyToAna = 0
const samples = { phyToAna: [], anaToPhy: [] }

for (const q of arr) {
  if (parseInt(q.roc_year) < 101 || parseInt(q.roc_year) > 106) continue
  if (q.subject !== '醫學(一)') continue
  if (q.subject_tag !== 'anatomy' && q.subject_tag !== 'physiology') continue
  const text = (q.question || '') + ' ' + Object.values(q.options || {}).join(' ')
  const hasAna = strongMatch(text, STRONG_ANATOMY)
  const hasPhy = strongMatch(text, STRONG_PHYSIOLOGY)
  // Only flip when one signal dominates
  if (q.subject_tag === 'physiology' && hasAna && !hasPhy) {
    if (samples.phyToAna.length < 5) samples.phyToAna.push(`#${q.number}: ${q.question.slice(0, 60)}`)
    q.subject_tag = 'anatomy'
    q.subject_name = '解剖學'
    phyToAna++
  } else if (q.subject_tag === 'anatomy' && hasPhy && !hasAna) {
    if (samples.anaToPhy.length < 5) samples.anaToPhy.push(`#${q.number}: ${q.question.slice(0, 60)}`)
    q.subject_tag = 'physiology'
    q.subject_name = '生理學'
    anaToPhy++
  }
}

fs.writeFileSync('questions.json', JSON.stringify(data, null, 2))
console.log('physiology → anatomy:', phyToAna)
console.log('anatomy → physiology:', anaToPhy)
console.log('\nphyToAna samples:')
for (const s of samples.phyToAna) console.log(' ', s)
console.log('\nanaToPhy samples:')
for (const s of samples.anaToPhy) console.log(' ', s)
