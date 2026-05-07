#!/usr/bin/env node
/**
 * Migrate pre-stored explanation field (questions JSON) to Supabase
 * ai_explanations table as `verified` status entries.
 *
 * Why: pre-stored explanations were generated offline (Haiku/Gemini) and shown
 * via a green "📝 參考解答" panel — diverging from cache-based "🤖 AI 解說".
 * Migrating unifies the path: every explanation goes through ai_explanations,
 * everything pre-stored becomes verified (free) by default.
 *
 * Behaviour:
 *  - Skips rows that already exist in ai_explanations (any status)
 *  - Marks new rows status='verified', model='prestored-haiku', upvotes=0
 *  - Dry-run mode: --dry-run (default reads ENV PRESTORED_DRY=1)
 *  - Limit per run: --limit N (default 5000)
 *
 * Usage:
 *   node scripts/migrate-prestored-explanations.js --dry-run
 *   node scripts/migrate-prestored-explanations.js --exam=doctor1
 *   node scripts/migrate-prestored-explanations.js (run all)
 */
require('dotenv/config')
const fs = require('fs')
const path = require('path')
const supabase = require('../supabase')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run') || process.env.PRESTORED_DRY === '1'
const examFilter = args.find(a => a.startsWith('--exam='))?.split('=')[1] || null
const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1]) || 5000

const BACKEND = path.join(__dirname, '..')
const EXAMS = [
  { id: 'doctor1', file: 'questions.json' },
  { id: 'doctor2', file: 'questions-doctor2.json' },
  { id: 'dental1', file: 'questions-dental1.json' },
  { id: 'dental2', file: 'questions-dental2.json' },
  { id: 'pharma1', file: 'questions-pharma1.json' },
  { id: 'pharma2', file: 'questions-pharma2.json' },
  { id: 'nursing', file: 'questions-nursing.json' },
  { id: 'nutrition', file: 'questions-nutrition.json' },
  { id: 'medlab', file: 'questions-medlab.json' },
  { id: 'pt', file: 'questions-pt.json' },
  { id: 'ot', file: 'questions-ot.json' },
  { id: 'radiology', file: 'questions-radiology.json' },
  { id: 'tcm1', file: 'questions-tcm1.json' },
  { id: 'tcm2', file: 'questions-tcm2.json' },
  { id: 'vet', file: 'questions-vet.json' },
  { id: 'social-worker', file: 'questions-social-worker.json' },
  { id: 'audiologist', file: 'questions-audiologist.json' },
  { id: 'speech-therapist', file: 'questions-speech-therapist.json' },
  { id: 'lawyer1', file: 'questions-lawyer1.json' },
  { id: 'judicial', file: 'questions-judicial.json' },
  { id: 'customs', file: 'questions-customs.json' },
  { id: 'civil-senior', file: 'questions-civil-senior.json' },
  { id: 'police', file: 'questions-police.json' },
  { id: 'police4', file: 'questions-police4.json' },
  { id: 'gsat', file: 'questions-gsat.json' },
  { id: 'ast', file: 'questions-ast.json' },
]

function buildCacheKey(examId, questionId) {
  return `exam:${examId}:${questionId}`
}

async function main() {
  if (!supabase) {
    console.error('No supabase client (missing env). Aborting.')
    process.exit(1)
  }
  console.log(`[migrate] mode=${dryRun ? 'DRY RUN' : 'LIVE'} | exam=${examFilter || 'all'} | limit=${limit}/exam`)

  let totalCandidates = 0, totalUploaded = 0, totalSkipped = 0
  for (const e of EXAMS) {
    if (examFilter && e.id !== examFilter) continue
    const fp = path.join(BACKEND, e.file)
    if (!fs.existsSync(fp)) { console.log(`  [${e.id}] file missing — skip`); continue }
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
    const arr = data.questions || data
    const candidates = arr.filter(q =>
      q.explanation && q.explanation.length > 30 && q.id != null
    ).slice(0, limit)
    if (!candidates.length) { console.log(`  [${e.id}] 0 candidates — skip`); continue }

    const cacheKeys = candidates.map(q => buildCacheKey(e.id, q.id))

    // Batch-check existing rows
    const existingSet = new Set()
    const CHUNK = 500
    for (let i = 0; i < cacheKeys.length; i += CHUNK) {
      const slice = cacheKeys.slice(i, i + CHUNK)
      const { data: rows, error } = await supabase
        .from('ai_explanations')
        .select('cache_key')
        .in('cache_key', slice)
      if (error) { console.error(`  [${e.id}] check error:`, error.message); break }
      for (const r of rows || []) existingSet.add(r.cache_key)
    }
    const toUpload = candidates.filter(q => !existingSet.has(buildCacheKey(e.id, q.id)))

    console.log(`  [${e.id}] candidates=${candidates.length}, already_in_db=${existingSet.size}, will_upload=${toUpload.length}`)
    totalCandidates += candidates.length
    totalSkipped += existingSet.size

    if (dryRun) continue

    // Upload in batches
    for (let i = 0; i < toUpload.length; i += CHUNK) {
      const slice = toUpload.slice(i, i + CHUNK)
      const rows = slice.map(q => ({
        cache_key: buildCacheKey(e.id, q.id),
        explanation_md: q.explanation,
        model: 'prestored',
        status: 'verified',
        upvotes: 0,
        downvotes: 0,
        hit_count: 1,
        updated_at: new Date().toISOString(),
      }))
      const { error } = await supabase
        .from('ai_explanations')
        .upsert(rows, { onConflict: 'cache_key', ignoreDuplicates: true })
      if (error) {
        console.error(`  [${e.id}] upload chunk ${i} error:`, error.message)
        continue
      }
      totalUploaded += rows.length
    }
    console.log(`  [${e.id}] uploaded ${toUpload.length}`)
  }

  console.log(`\n=== summary: candidates=${totalCandidates}, already_existed=${totalSkipped}, uploaded=${totalUploaded} ===`)
}

main().catch(e => { console.error(e); process.exit(1) })
