#!/usr/bin/env node
/**
 * Fix doctor2 subject_tag using canonical Q-number ranges.
 *
 * Observed: 110-115 第一次 have consistent ranges across all 6 years:
 *   醫學(三): Q1-80 internal_medicine (single sub-tag)
 *   醫學(四): Q1-33 pediatrics | Q34-43 dermatology | Q44-58 neurology | Q59-80 psychiatry
 *   醫學(五): Q1-55 surgery | Q56-63 orthopedics | Q64-80 urology
 *   醫學(六): Q1-8 anesthesia | Q9-18 ophthalmology | Q19-27 ent |
 *            Q28-57 obstetrics_gynecology | Q58-75 rehabilitation | Q76-80 medical_law_ethics
 *
 * 第二次 and 100-109 第一次 have everything flattened to the paper's dominant tag.
 * Apply canonical ranges to fix all years' sub-classification.
 */

const fs = require('fs')
const path = require('path')

const FILE = path.join(__dirname, '..', 'questions-doctor2.json')

// stage_id is from doctor2.json config — let's read it dynamically
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'exam-configs', 'doctor2.json'), 'utf8'))
const stageIdByTag = {}
for (const s of cfg.stages) stageIdByTag[s.tag] = s.id

const RANGES = {
  '醫學(三)': [
    { tag: 'internal_medicine', min: 1, max: 80 },
  ],
  '醫學(四)': [
    { tag: 'pediatrics',  min: 1,  max: 33 },
    { tag: 'dermatology', min: 34, max: 43 },
    { tag: 'neurology',   min: 44, max: 58 },
    { tag: 'psychiatry',  min: 59, max: 80 },
  ],
  '醫學(五)': [
    { tag: 'surgery',     min: 1,  max: 55 },
    { tag: 'orthopedics', min: 56, max: 63 },
    { tag: 'urology',     min: 64, max: 80 },
  ],
  '醫學(六)': [
    { tag: 'anesthesia',             min: 1,  max: 8  },
    { tag: 'ophthalmology',          min: 9,  max: 18 },
    { tag: 'ent',                    min: 19, max: 27 },
    { tag: 'obstetrics_gynecology',  min: 28, max: 57 },
    { tag: 'rehabilitation',         min: 58, max: 75 },
    { tag: 'medical_law_ethics',     min: 76, max: 80 },
  ],
}

function getTag(subject, number) {
  const ranges = RANGES[subject]
  if (!ranges) return null
  for (const r of ranges) {
    if (number >= r.min && number <= r.max) return r.tag
  }
  return null
}

const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
const questions = Array.isArray(raw) ? raw : raw.questions

let fixed = 0, skipped = 0, unknown = 0
for (const q of questions) {
  if (!RANGES[q.subject]) continue
  const tag = getTag(q.subject, q.number)
  if (!tag) { unknown++; continue }
  const stageId = stageIdByTag[tag]
  if (q.subject_tag === tag && (!stageId || q.stage_id === stageId)) { skipped++; continue }
  q.subject_tag = tag
  if (stageId) q.stage_id = stageId
  fixed++
}

fs.writeFileSync(FILE, JSON.stringify(raw, null, 2))
console.log(`doctor2 tag reclassification done:`)
console.log(`  Fixed: ${fixed}`)
console.log(`  Already-correct: ${skipped}`)
console.log(`  Unknown (Q number out of range): ${unknown}`)
