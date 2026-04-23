#!/usr/bin/env node
/**
 * Fix subject_tag + stage_id for 醫師一階 醫學(一)/醫學(二) 101-112年
 *
 * Problem: keyword-based classifier assigned wrong tags for 101-112.
 * 113-115 are correct. 100年 (240-question format) is skipped.
 *
 * Fix: apply fixed question-number → tag ranges (stable since 101年 200-Q reform).
 */

const fs = require('fs')
const path = require('path')

const FILE = path.join(__dirname, '..', 'questions.json')

const MED1_RANGES = [
  { tag: 'anatomy',      stage: 1, min: 1,  max: 31  },
  { tag: 'embryology',   stage: 2, min: 32, max: 36  },
  { tag: 'histology',    stage: 3, min: 37, max: 46  },
  { tag: 'physiology',   stage: 4, min: 47, max: 73  },
  { tag: 'biochemistry', stage: 5, min: 74, max: 100 },
]

const MED2_RANGES = [
  { tag: 'microbiology',  stage: 6,  min: 1,  max: 28  },
  { tag: 'parasitology',  stage: 7,  min: 29, max: 35  },
  { tag: 'public_health', stage: 8,  min: 36, max: 50  },
  { tag: 'pharmacology',  stage: 9,  min: 51, max: 75  },
  { tag: 'pathology',     stage: 10, min: 76, max: 100 },
]

function getCorrectTag(subject, number) {
  const ranges = subject === '醫學(一)' ? MED1_RANGES : MED2_RANGES
  for (const r of ranges) {
    if (number >= r.min && number <= r.max) return { tag: r.tag, stage: r.stage }
  }
  return null
}

const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
const questions = Array.isArray(raw) ? raw : raw.questions

let fixed = 0
let skipped = 0

for (const q of questions) {
  if (q.subject !== '醫學(一)' && q.subject !== '醫學(二)') continue
  const yr = parseInt(q.roc_year)
  if (yr < 101 || yr > 112) continue

  const correct = getCorrectTag(q.subject, q.number)
  if (!correct) { console.warn('No range for', q.subject, q.number); continue }

  if (q.subject_tag === correct.tag && q.stage_id === correct.stage) {
    skipped++
    continue
  }

  q.subject_tag = correct.tag
  q.stage_id = correct.stage
  fixed++
}

const out = Array.isArray(raw) ? questions : { ...raw, questions }
fs.writeFileSync(FILE, JSON.stringify(out, null, 2))
console.log(`Done. Fixed: ${fixed}, already-correct: ${skipped}`)
