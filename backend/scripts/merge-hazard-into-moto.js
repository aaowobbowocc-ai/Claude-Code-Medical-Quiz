#!/usr/bin/env node
/**
 * 把 _tmp/hazard-questions.json 的 126 題危險感知題塞進
 * questions-driver-moto.json，subject_tag='hazard_perception'。
 *
 * 來源：公路局《機車危險感知影片選擇題（中文版）》PDF
 * 政府公開資料、教育用途，每題保留 hazard_video_id 與 source attribution。
 *
 * 影片實際播放需到公路局教育平台（hpt.thb.gov.tw）。
 */
const fs = require('fs')
const path = require('path')

const HAZARD = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '_tmp', 'hazard-questions.json'), 'utf8'))
const FP = path.join(__dirname, '..', 'questions-driver-moto.json')
const data = JSON.parse(fs.readFileSync(FP, 'utf8'))
const arr = data.questions || data

// 移除舊的 hazard_perception（重跑安全）
const before = arr.length
const cleaned = arr.filter(q => q.subject_tag !== 'hazard_perception')
console.log(`removed ${before - cleaned.length} existing hazard rows`)

// 找下一個可用的 number 起點 — 既有題號最大值 +1
const maxNum = Math.max(...cleaned.map(q => q.number || 0))
console.log(`existing max number: ${maxNum}`)

let added = 0
for (const h of HAZARD) {
  const newQ = {
    id: `moto_hazard_${h.number}`,
    subject: '危險感知',
    subject_tag: 'hazard_perception',
    subject_name: '危險感知',
    stage_id: 1,
    number: maxNum + h.number,
    question: h.question,
    options: { A: h.options.A, B: h.options.B, C: h.options.C },
    answer: h.answer_letter,
    type: 'choice',
    hazard_video_id: h.hazard_video_id,
    source_url: 'https://hpt.thb.gov.tw/',
    attribution: '公路局 機車危險感知教育平台',
  }
  cleaned.push(newQ)
  added++
}
console.log(`added ${added} hazard questions`)

const newData = data.questions ? { ...data, questions: cleaned } : cleaned
fs.writeFileSync(FP, JSON.stringify(newData, null, 2))
console.log(`wrote ${FP} — ${cleaned.length} total`)
