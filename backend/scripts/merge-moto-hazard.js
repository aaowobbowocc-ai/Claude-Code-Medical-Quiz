#!/usr/bin/env node
// Merge driver-moto-hazard.json into questions-driver-moto.json
// Fix subject_tag mismatch: moto_hazard → hazard_perception (matches config)
const fs = require('fs')
const main = JSON.parse(fs.readFileSync('questions-driver-moto.json', 'utf-8'))
const haz = JSON.parse(fs.readFileSync('questions-driver-moto-hazard.json', 'utf-8'))
const mainArr = main.questions || main
const hazArr = haz.questions || haz
console.log('main before:', mainArr.length, 'hazard:', hazArr.length)

const existingIds = new Set(mainArr.map(q => q.id))
let merged = 0
for (const q of hazArr) {
  if (existingIds.has(q.id)) continue
  q.subject_tag = 'hazard_perception' // align with exam-configs/driver-moto.json
  mainArr.push(q)
  merged++
}
fs.writeFileSync('questions-driver-moto.json', JSON.stringify(main, null, 2))
console.log('merged:', merged, '| total:', mainArr.length)
// Remove the now-empty source file
fs.unlinkSync('questions-driver-moto-hazard.json')
console.log('removed questions-driver-moto-hazard.json')
