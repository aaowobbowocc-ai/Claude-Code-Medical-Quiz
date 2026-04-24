#!/usr/bin/env node
/**
 * Fix dental2 subject_tag using canonical Q-number ranges derived from 110-115.
 * Same strategy as fix-doctor2-subject-tags.js.
 */
const fs = require('fs')
const path = require('path')

const FILE = path.join(__dirname, '..', 'questions-dental2.json')
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'exam-configs', 'dental2.json'), 'utf8'))
const stageIdByTag = {}
for (const s of cfg.stages) stageIdByTag[s.tag] = s.id

const RANGES = {
  '卷一': [
    { tag: 'periodontics', min: 1,  max: 28 },
    { tag: 'oral_surgery', min: 29, max: 68 },
    { tag: 'periodontics', min: 69, max: 80 },
  ],
  '卷二': [
    { tag: 'endodontics',          min: 1,  max: 20 },
    { tag: 'operative_dentistry',  min: 21, max: 40 },
    { tag: 'orthodontics',         min: 41, max: 60 },
    { tag: 'pediatric_dentistry',  min: 61, max: 80 },
  ],
  '卷三': [
    { tag: 'removable_prosthodontics', min: 1,  max: 27 },
    { tag: 'dental_materials',         min: 28, max: 30 },
    { tag: 'fixed_prosthodontics',     min: 31, max: 43 },
    { tag: 'dental_materials',         min: 44, max: 66 },
    { tag: 'fixed_prosthodontics',     min: 67, max: 80 },
  ],
  '卷四': [
    { tag: 'dental_public_health', min: 1,  max: 1  },
    { tag: 'dental_radiology',     min: 2,  max: 8  },
    { tag: 'dental_public_health', min: 9,  max: 15 },
    { tag: 'dental_radiology',     min: 16, max: 48 },
    { tag: 'dental_public_health', min: 49, max: 80 },
  ],
}

function getTag(subject, number) {
  const ranges = RANGES[subject]
  if (!ranges) return null
  for (const r of ranges) if (number >= r.min && number <= r.max) return r.tag
  return null
}

const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
const questions = Array.isArray(raw) ? raw : raw.questions
let fixed = 0, skipped = 0
for (const q of questions) {
  if (!RANGES[q.subject]) continue
  const tag = getTag(q.subject, q.number)
  if (!tag) continue
  const stageId = stageIdByTag[tag]
  if (q.subject_tag === tag) { skipped++; continue }
  q.subject_tag = tag
  if (stageId) q.stage_id = stageId
  fixed++
}
fs.writeFileSync(FILE, JSON.stringify(raw, null, 2))
console.log(`dental2: fixed=${fixed}, already-correct=${skipped}`)
