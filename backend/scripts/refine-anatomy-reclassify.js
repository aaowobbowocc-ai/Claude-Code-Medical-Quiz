#!/usr/bin/env node
// Revert over-broad reclassification. Look for questions tagged anatomy that
// have STRONG physiology signals (mechanism/regulation/process words) but
// LACK strong structural anatomy keywords, and flip them back to physiology.
const fs = require('fs')

const STRONG_PHYSIOLOGY = [
  /機(制|轉)/, /調節/, /作用機/,
  /分泌.*(荷爾蒙|激素|物質)/, /分泌(腎上腺素|去甲腎上腺素|腦下垂體)/,
  /(動作電位|終板電位|心電圖|心律)/,
  /(收縮|舒張).*(蛋白|肌|心)/, /(心室|心房).*(收縮|舒張)/,
  /神經傳導物/, /神經調節/, /motor.*control/i, /signal.*transduction/i,
  /(代謝|代償|失調|穩態|恆定)/,
  /(滲透壓|血壓|血流|心輸出量|心搏量|肺活量)/,
  /(腎絲球過濾|腎絲球|腎小管.*(再吸收|分泌))/,
  /(吸收|分泌|過濾|排泄).*(速率|機制|過程)/,
  /(電位|離子.*通道|去極化|過極化|再極化)/,
  /referred pain.*(機|轉)/,
  /transmitter|receptor.*activation/i,
  /Peyer.*patch/, // 派亞氏斑 — actually histology/immuno but more physio than anat
]

const STRONG_ANATOMY_OVERRIDE = [
  /白質|灰質/,
  /(神經叢|韌帶|肌腱)/,
  /(corpus callosum|fasciculus|ganglion)/i,
  /經過.*三角/, /附著於.*骨/,
  /(動脈|靜脈).*分支.*供應/,
]

const data = JSON.parse(fs.readFileSync('questions.json', 'utf-8'))
const arr = data.questions || data
let flipped = 0
for (const q of arr) {
  if (parseInt(q.roc_year) < 101 || parseInt(q.roc_year) > 106) continue
  if (q.subject !== '醫學(一)') continue
  if (q.subject_tag !== 'anatomy') continue
  const text = (q.question || '') + ' ' + Object.values(q.options || {}).join(' ')
  const hasPhy = STRONG_PHYSIOLOGY.some(p => p.test(text))
  const hasStrongAna = STRONG_ANATOMY_OVERRIDE.some(p => p.test(text))
  if (hasPhy && !hasStrongAna) {
    q.subject_tag = 'physiology'
    q.subject_name = '生理學'
    flipped++
  }
}
fs.writeFileSync('questions.json', JSON.stringify(data, null, 2))
console.log('anatomy → physiology (over-reach revert):', flipped)
