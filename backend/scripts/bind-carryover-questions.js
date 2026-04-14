#!/usr/bin/env node
// Bind 承上題 questions to their previous-question context so they are
// self-contained in every display mode (favorites, random practice, PvP,
// browse filtered, etc.). Also inherits images from the root case question
// when the current question references an image but has none attached.
//
// Idempotent: uses a unique marker string, skips questions already processed.
// Writes changes in place to all questions-*.json files in backend/.
const fs = require('fs')
const path = require('path')

const BACKEND_DIR = path.join(__dirname, '..')
const MARKER = '【承上題．前情提要】'
const CARRY_RE = /^[\s　]*(承(上|前)題|同上題|依上題|依前題|根據上題|承上\b|上題已述|上題述)/

function formatAnswer(q) {
  if (!q.answer || !q.options) return null
  const keys = String(q.answer).split(/[,\s、]+/).filter(Boolean)
  const parts = []
  for (const k of keys) {
    if (q.options[k]) parts.push(`(${k}) ${q.options[k]}`)
  }
  return parts.length ? parts.join(' / ') : null
}

function buildContext(q, group) {
  const chain = []
  let cur = group.get(q.number - 1)
  let steps = 0
  while (cur && steps < 10) {
    chain.unshift(cur)
    if (!CARRY_RE.test(cur.question || '')) break
    cur = group.get(cur.number - 1)
    steps++
  }
  if (chain.length === 0) return null
  const root = chain[0]
  let ctx = MARKER + '\n'
  ctx += `第${root.number}題：${root.question}\n`
  const rootAns = formatAnswer(root)
  if (rootAns) ctx += `上題答案：${rootAns}\n`
  for (let i = 1; i < chain.length; i++) {
    const c = chain[i]
    ctx += `第${c.number}題：${c.question}\n`
    const ans = formatAnswer(c)
    if (ans) ctx += `  → 答案：${ans}\n`
  }
  ctx += '──────────\n'
  return { ctx, root }
}

function processFile(file) {
  const full = path.join(BACKEND_DIR, file)
  const db = JSON.parse(fs.readFileSync(full, 'utf8'))
  const qs = db.questions || db
  const byKey = {}
  for (const q of qs) {
    const k = q.exam_code + '|' + (q.subject || '')
    if (!byKey[k]) byKey[k] = new Map()
    byKey[k].set(q.number, q)
  }

  let bound = 0, imageInherited = 0, skippedAlready = 0
  for (const q of qs) {
    const stem = q.question || ''
    if (!CARRY_RE.test(stem)) continue
    if (stem.includes(MARKER)) { skippedAlready++; continue }
    const k = q.exam_code + '|' + (q.subject || '')
    const group = byKey[k]
    if (!group) continue
    const built = buildContext(q, group)
    if (!built) continue
    q.question = built.ctx + stem
    bound++
    const hasOwnImg = Array.isArray(q.images) && q.images.length > 0
    if (!hasOwnImg && Array.isArray(built.root.images) && built.root.images.length > 0) {
      q.images = [...built.root.images]
      imageInherited++
    }
  }

  if (bound > 0 || imageInherited > 0) {
    if (db.metadata) db.metadata.last_updated = new Date().toISOString()
    fs.writeFileSync(full, JSON.stringify(db, null, 2))
  }
  return { bound, imageInherited, skippedAlready }
}

const files = fs.readdirSync(BACKEND_DIR).filter(f => /^questions.*\.json$/.test(f))
let totalBound = 0, totalImg = 0, totalSkip = 0
for (const f of files) {
  const r = processFile(f)
  if (r.bound || r.imageInherited || r.skippedAlready) {
    console.log(`${f}: bound=${r.bound} images_inherited=${r.imageInherited} already=${r.skippedAlready}`)
  }
  totalBound += r.bound
  totalImg += r.imageInherited
  totalSkip += r.skippedAlready
}
console.log(`\nTOTAL bound=${totalBound} images_inherited=${totalImg} already_processed=${totalSkip}`)
