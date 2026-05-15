#!/usr/bin/env node
// Regenerate IDs for entries with pure-numeric IDs to prevent cross-year collisions.
// Format: {prefix}_{exam_code}_p{paperIdx}_{number}
// Affects: audiologist, speech-therapist (the two exams with confirmed ID reuse).
const fs = require('fs')

// Paper order matches each exam's typical paper list. paperIdx is 1-based.
// CRITICAL: this list must be FROZEN — if a subject is reordered or removed,
// existing IDs (and any caches referencing them) break. New subjects must be
// appended to keep prior indices stable.
const PAPERS = {
  'questions-audiologist.json': {
    prefix: 'audiologist',
    papers: ['基礎聽力科學','行為聽力學','電生理聽力學','聽覺輔具原理與實務學','聽覺與平衡系統之創健與復健學','聽語溝通障礙學（包括專業倫理）'],
  },
  'questions-speech-therapist.json': {
    prefix: 'speech',
    // FROZEN — initial regen used [...seen].sort() output. Keep this list intact.
    papers: ['兒童語言障礙','嗓音與吞嚥障礙','基礎言語科學','構音與語暢障礙','神經性溝通障礙學','聽力學與輔助溝通系統（包括專業倫理）'],
  },
}

for (const [fp, cfg] of Object.entries(PAPERS)) {
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
  const arr = data.questions || data
  const paperIdx = Object.fromEntries(cfg.papers.map((p, i) => [p, i + 1]))
  // Sanity: ensure all subjects in data are in the frozen list (catches drift)
  const subjects = new Set(arr.map(q => q.subject).filter(Boolean))
  for (const s of subjects) {
    if (!paperIdx[s]) console.warn(`  ⚠ subject not in frozen paper list: ${s} (file=${fp})`)
  }
  let renamed = 0
  for (const q of arr) {
    if (!q.id) continue
    // Only regen pure-numeric IDs (legacy format)
    if (!/^\d+$/.test(String(q.id))) continue
    const idx = paperIdx[q.subject] || 0
    if (!idx) { console.log('  ! no paperIdx for subject:', q.subject); continue }
    const newId = `${cfg.prefix}_${q.exam_code}_p${idx}_${q.number}`
    q._legacy_id = q.id
    q.id = newId
    renamed++
  }
  // Verify no remaining dupes
  const seen = new Set()
  const dups = []
  for (const q of arr) {
    if (seen.has(q.id)) dups.push(q.id)
    seen.add(q.id)
  }
  console.log(fp, ': renamed', renamed, '| remaining dups:', dups.length)
  if (dups.length > 0) console.log('  dup sample:', dups.slice(0, 5))
  fs.writeFileSync(fp, JSON.stringify(data, null, 2))
}
