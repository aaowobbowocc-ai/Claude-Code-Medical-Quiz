#!/usr/bin/env node
/**
 * Remove stale gap_reason / incomplete labels for questions whose
 * options are all populated and (for image-related ones) image_url is set.
 *
 * Rules:
 *   - If incomplete === true or "true": real broken — leave alone
 *   - If incomplete === "image_options": real schema, leave alone
 *   - Else if gap_reason set, check options:
 *       - all 4 options non-empty AND question non-empty:
 *           - if gap_reason in {empty_options}: clear gap_reason
 *           - if gap_reason in {missing_image, missing_image_dep, image_only_options}:
 *               only clear if image_url is set OR question doesn't reference 圖
 */
const fs = require('fs')
const path = require('path')

const BACKEND = path.join(__dirname, '..')

const PIC_KEYWORDS = ['如圖','下圖','附圖','右圖','左圖','上圖','本圖','此圖','圖示','依下圖','依圖','見圖','所示之圖','依據下圖']
function mentionsImage(t){ if(!t) return false; return PIC_KEYWORDS.some(k=>t.includes(k)) }

const SKIP = new Set(['questions-pt.json', 'questions-ot.json'])

function processFile(fp) {
  let raw
  try { raw = JSON.parse(fs.readFileSync(fp, 'utf8')) } catch { return null }
  const arr = Array.isArray(raw) ? raw : (raw.questions || raw.data)
  if (!arr) return null

  let cleared = 0
  for (const q of arr) {
    if (!q.gap_reason && !q.incomplete) continue
    // keep image_options schema
    if (q.incomplete === 'image_options') continue
    // skip true incomplete
    if (q.incomplete === true || q.incomplete === 'true') continue

    if (q.gap_reason) {
      const opts = q.options || {}
      const allFilled = ['A','B','C','D'].every(k => opts[k] && opts[k] !== '')
      const has3OK = ['A','B','C'].every(k => opts[k] && opts[k] !== '')  // driver-license style
      const okOptions = allFilled || has3OK
      const okQuestion = q.question && q.question.length >= 5
      const reason = q.gap_reason
      let canClear = false
      if (reason === 'empty_options' && okOptions && okQuestion) canClear = true
      else if (['missing_image','missing_image_dep','image_only_options'].includes(reason)) {
        // need image_url present OR question doesn't reference image
        if ((q.image_url || (q.images && q.images.length)) && okOptions && okQuestion) canClear = true
        else if (!mentionsImage(q.question) && okOptions && okQuestion) canClear = true
      }
      if (canClear) {
        delete q.gap_reason
        if (q.incomplete === false || q.incomplete === 'false') delete q.incomplete
        cleared++
      }
    } else if (q.incomplete === false || q.incomplete === 'false') {
      // incomplete:false is meaningless noise
      delete q.incomplete
      cleared++
    }
  }
  if (cleared > 0) {
    const toSave = Array.isArray(raw) ? arr : raw
    fs.writeFileSync(fp, JSON.stringify(toSave, null, 2))
  }
  return cleared
}

function main() {
  const files = fs.readdirSync(BACKEND).filter(f =>
    (f === 'questions.json' || /^questions-.*\.json$/.test(f))
    && !SKIP.has(f) && !/\.bak/.test(f)
  )
  let total = 0
  for (const f of files) {
    const fp = path.join(BACKEND, f)
    const cleared = processFile(fp)
    if (cleared !== null && cleared > 0) {
      console.log(`✓ ${f}: cleared ${cleared} stale labels`)
      total += cleared
    }
  }
  console.log(`Total: ${total} stale labels cleared`)
}

main()
