#!/usr/bin/env node
/**
 * Pre-generate AI explanations for hot questions using Gemini Flash Lite.
 *
 * Why: Cache misses cost ~0.08 NTD on Claude Haiku. By pre-filling cache with
 * Gemini Flash Lite (~12x cheaper), we convert future Haiku calls into free
 * Supabase cache hits.
 *
 * Strategy: pick N questions diversified across exams, skip those already cached,
 * call Gemini in parallel (with concurrency limit), upsert to ai_explanations.
 *
 * Usage:
 *   node scripts/pregen-explanations.js --limit 500 --dry-run     # plan only
 *   node scripts/pregen-explanations.js --limit 500               # execute
 *   node scripts/pregen-explanations.js --exam doctor1 --limit 50 # single exam
 */

require('dotenv').config()
const fs = require('fs')
const path = require('path')
const https = require('https')
const supabase = require('../supabase')

const GEMINI_KEY = process.env.GEMINI_API_KEY ||
  (() => { try { return fs.readFileSync(path.join(__dirname, '..', '.gemini-key'), 'utf8').trim() } catch { return '' } })()
const GEMINI_MODEL = 'gemini-2.5-flash-lite' // cheapest variant, $0.10/$0.40 per M

const args = process.argv.slice(2)
const getArg = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : def
}
const DRY_RUN = args.includes('--dry-run')
const LIMIT = parseInt(getArg('--limit', '500'))
const EXAM_FILTER = getArg('--exam', null)
// Gemini 2.5 Flash-Lite free tier: 15 RPM, 1000 RPD
// Stay at 12 RPM (5s spacing, single worker) for safety margin
const CONCURRENCY = 1
const DELAY_MS = 5000
const RECENT_YEARS = new Set(['113', '114', '115']) // prioritize recent

if (!GEMINI_KEY) {
  console.error('Missing GEMINI_API_KEY (env or backend/.gemini-key)')
  process.exit(1)
}
if (!supabase && !DRY_RUN) {
  console.error('Missing Supabase. Add SUPABASE_URL + SUPABASE_KEY (service_role) to backend/.env')
  console.error('  Get service_role from Supabase dashboard → Project Settings → API')
  process.exit(1)
}

function buildCacheKey({ shared_bank, exam, question_id }) {
  if (!question_id) return null
  if (shared_bank) return `shared:${shared_bank}:${question_id}`
  if (exam) return `exam:${exam}:${question_id}`
  return null
}

function buildPrompt(q, examName) {
  const optionText = Object.entries(q.options || {}).map(([k, v]) => `${k}. ${v}`).join('\n')
  return `你是一位臺灣${examName}的解題老師，用繁體中文回答。

科目：${q.subject_name || q.subject || ''}
題目：${q.question}

選項：
${optionText}

正確答案：${q.answer}

請用以下格式回答（每段都要有，簡潔扼要）：

**✅ 為什麼答案是 ${q.answer}**
（說明核心機制或概念，2-3句）

**❌ 排除其他選項**
（每個錯誤選項一句話說明為何不對）

**🧠 記憶關鍵字**
（給一個好記的口訣或記憶技巧）

**🏥 臨床應用**
（一句話說明這個知識點在臨床上的意義）`
}

function callGemini(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 600, temperature: 0.3 },
    })
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`))
        try {
          const parsed = JSON.parse(data)
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text
          const usage = parsed.usageMetadata || {}
          if (!text) return reject(new Error('empty response'))
          resolve({ text, inputTokens: usage.promptTokenCount || 0, outputTokens: usage.candidatesTokenCount || 0 })
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function loadCachedKeys() {
  if (!supabase) return new Set()
  const all = new Set()
  let offset = 0
  const batch = 1000
  while (true) {
    const { data, error } = await supabase
      .from('ai_explanations')
      .select('cache_key')
      .range(offset, offset + batch - 1)
    if (error) { console.warn('cache load error:', error.message); break }
    if (!data || data.length === 0) break
    for (const r of data) all.add(r.cache_key)
    if (data.length < batch) break
    offset += batch
  }
  return all
}

// Diversified sampler: per exam, take up to N questions, prioritize recent years
function selectQuestions(examData, examConfigs, perExam) {
  const picked = []
  const examIds = EXAM_FILTER ? [EXAM_FILTER] : Object.keys(examData)
  for (const examId of examIds) {
    const data = examData[examId]
    if (!data || !data.questions) continue
    const pool = data.questions.filter(q =>
      q.question && q.options && q.answer &&
      Object.keys(q.options).length >= 4 &&
      !q.incomplete &&
      !q.is_deprecated
    )
    // Prefer recent years first, then fill from older
    const recent = pool.filter(q => RECENT_YEARS.has(q.roc_year))
    const older = pool.filter(q => !RECENT_YEARS.has(q.roc_year))
    const ordered = [...recent, ...older]
    // Deterministic pseudo-random shuffle per exam (avoid picking same every run)
    const seed = examId.length
    ordered.sort((a, b) => {
      const ha = (String(a.id).charCodeAt(0) + seed) % 997
      const hb = (String(b.id).charCodeAt(0) + seed) % 997
      return ha - hb
    })
    const take = ordered.slice(0, perExam)
    const examName = examConfigs[examId]?.name || examId
    for (const q of take) {
      picked.push({ q, examId, examName })
    }
  }
  return picked
}

async function processOne({ q, examId, examName }, state) {
  const cacheKey = buildCacheKey({ exam: examId, question_id: q.id })
  if (!cacheKey) { state.skipped++; return }
  if (state.cached.has(cacheKey)) { state.skipped++; return }

  const prompt = buildPrompt(q, examName)
  try {
    const { text, inputTokens, outputTokens } = await callGeminiWithRetry(prompt)
    state.inTokens += inputTokens
    state.outTokens += outputTokens
    if (DRY_RUN) {
      state.wouldGenerate++
      return
    }
    await supabase.from('ai_explanations').upsert({
      cache_key: cacheKey,
      explanation_md: text,
      model: GEMINI_MODEL,
      status: 'pending',
      upvotes: 0,
      downvotes: 0,
      hit_count: 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'cache_key' })
    state.generated++
    state.cached.add(cacheKey)
    if (state.generated % 10 === 0) {
      const costNTD = (state.inTokens * 0.10 + state.outTokens * 0.40) / 1_000_000 * 30 // rough USD→NTD
      console.log(`  [${state.generated}/${state.total}] running cost ≈ ${costNTD.toFixed(2)} NTD`)
    }
  } catch (e) {
    state.errors.push(`${examId} ${q.id}: ${e.message}`)
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function runConcurrent(items, state, concurrency) {
  let idx = 0
  async function worker() {
    while (idx < items.length) {
      const i = idx++
      await processOne(items[i], state)
      await sleep(DELAY_MS) // respect Gemini free-tier RPM
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
}

// Retry on 429 rate limit errors with exponential backoff
async function callGeminiWithRetry(prompt, attempt = 0) {
  try {
    return await callGemini(prompt)
  } catch (e) {
    if (e.message?.includes('429') && attempt < 3) {
      const wait = 15000 * (attempt + 1) // 15s, 30s, 45s
      console.log(`  ⏸ rate limited, waiting ${wait/1000}s...`)
      await sleep(wait)
      return callGeminiWithRetry(prompt, attempt + 1)
    }
    throw e
  }
}

async function main() {
  console.log(`=== Pre-gen AI explanations (Gemini Flash Lite) ===`)
  console.log(`Limit: ${LIMIT}, Exam: ${EXAM_FILTER || 'all'}, Dry run: ${DRY_RUN}`)

  // Load all question JSONs
  const backendDir = path.join(__dirname, '..')
  const examConfigs = {}
  for (const f of fs.readdirSync(path.join(backendDir, 'exam-configs'))) {
    if (!f.endsWith('.json')) continue
    const cfg = JSON.parse(fs.readFileSync(path.join(backendDir, 'exam-configs', f), 'utf8'))
    examConfigs[cfg.id] = cfg
  }
  const examData = {}
  for (const id of Object.keys(examConfigs)) {
    const cfg = examConfigs[id]
    if (!cfg.questionsFile) continue
    const p = path.join(backendDir, cfg.questionsFile)
    if (!fs.existsSync(p)) continue
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    examData[id] = { questions: Array.isArray(raw) ? raw : raw.questions }
  }

  const perExam = EXAM_FILTER ? LIMIT : Math.ceil(LIMIT / Object.keys(examData).length)
  const picked = selectQuestions(examData, examConfigs, perExam).slice(0, LIMIT)
  console.log(`Picked ${picked.length} questions across ${new Set(picked.map(p => p.examId)).size} exams`)

  const cached = await loadCachedKeys()
  console.log(`Found ${cached.size} existing cached explanations`)

  const state = {
    total: picked.length, cached,
    generated: 0, skipped: 0, wouldGenerate: 0,
    inTokens: 0, outTokens: 0,
    errors: [],
  }

  const startTime = Date.now()
  await runConcurrent(picked, state, CONCURRENCY)
  const elapsed = (Date.now() - startTime) / 1000

  const costUSD = (state.inTokens * 0.10 + state.outTokens * 0.40) / 1_000_000
  const costNTD = costUSD * 30

  console.log('\n=== DONE ===')
  console.log(`Generated: ${state.generated}`)
  console.log(`Skipped (already cached): ${state.skipped}`)
  if (DRY_RUN) console.log(`Would generate: ${state.wouldGenerate}`)
  console.log(`Errors: ${state.errors.length}`)
  console.log(`Tokens in/out: ${state.inTokens} / ${state.outTokens}`)
  console.log(`Cost: $${costUSD.toFixed(4)} USD ≈ ${costNTD.toFixed(2)} NTD`)
  console.log(`Elapsed: ${elapsed.toFixed(1)}s`)
  if (state.errors.length) {
    console.log('\nFirst 5 errors:')
    state.errors.slice(0, 5).forEach(e => console.log('  ' + e))
  }
}

main().catch(e => { console.error(e); process.exit(1) })
