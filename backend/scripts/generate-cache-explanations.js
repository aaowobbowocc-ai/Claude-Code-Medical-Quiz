#!/usr/bin/env node
/**
 * 批次生成參考解答到 Supabase ai_explanations cache (status=verified)。
 *
 * 使用 Vertex AI Gemini 2.5 Flash（免費 credit / 隨便花），所有醫學題 RAG
 * 強化（從醫學百科撈相關段落餵 prompt）。已 cache 的題目直接 skip。
 *
 * 用法：
 *   node scripts/generate-cache-explanations.js --dry-run
 *   node scripts/generate-cache-explanations.js --exam=doctor1 --limit=100
 *   node scripts/generate-cache-explanations.js --exam=all --concurrency=5
 *
 * Flags:
 *   --exam=ID       單一考試 (doctor1/doctor2/...) 或 'all'（預設 all）
 *   --limit=N       每個考試最多生 N 題（預設無上限）
 *   --concurrency=N 並發數（預設 3，避免 rate limit）
 *   --dry-run       只算數，不生成
 *   --status=verified | pending（預設 verified — 直接成為公共解答）
 */
require('dotenv/config')
const fs = require('fs')
const path = require('path')
const { GoogleAuth } = require('google-auth-library')
const supabase = require('../supabase')
const rag = require('../rag')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const BACKEND = path.join(__dirname, '..')
const VERTEX_PROJECT = 'gen-lang-client-0502672630'
const VERTEX_REGION = 'us-central1'
const VERTEX_MODEL = 'gemini-2.5-flash'
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const examFilter = args.find(a => a.startsWith('--exam='))?.split('=')[1] || 'all'
const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1]) || Infinity
const concurrency = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1]) || 3
const targetStatus = args.find(a => a.startsWith('--status='))?.split('=')[1] || 'verified'

const EXAM_FILES = {
  doctor1: 'questions.json',
  doctor2: 'questions-doctor2.json',
  dental1: 'questions-dental1.json',
  dental2: 'questions-dental2.json',
  pharma1: 'questions-pharma1.json',
  pharma2: 'questions-pharma2.json',
  nursing: 'questions-nursing.json',
  nutrition: 'questions-nutrition.json',
  medlab: 'questions-medlab.json',
  pt: 'questions-pt.json',
  ot: 'questions-ot.json',
  radiology: 'questions-radiology.json',
  tcm1: 'questions-tcm1.json',
  tcm2: 'questions-tcm2.json',
  vet: 'questions-vet.json',
  audiologist: 'questions-audiologist.json',
  'speech-therapist': 'questions-speech-therapist.json',
  'social-worker': 'questions-social-worker.json',
  lawyer1: 'questions-lawyer1.json',
  judicial: 'questions-judicial.json',
  customs: 'questions-customs.json',
  'civil-senior': 'questions-civil-senior.json',
  police: 'questions-police.json',
  police4: 'questions-police4.json',
}

const MEDICAL_EXAMS = new Set([
  'doctor1','doctor2','dental1','dental2','pharma1','pharma2',
  'nursing','nutrition','medlab','pt','ot','radiology','tcm1','tcm2','vet'
])

const EXAM_NAME = {
  doctor1: '醫師一階', doctor2: '醫師二階',
  dental1: '牙醫一階', dental2: '牙醫二階',
  pharma1: '藥師一階', pharma2: '藥師二階',
  nursing: '護理師', nutrition: '營養師',
  medlab: '醫事檢驗師', pt: '物理治療師', ot: '職能治療師', radiology: '醫事放射師',
  tcm1: '中醫師一階', tcm2: '中醫師二階',
  vet: '獸醫師', audiologist: '聽力師', 'speech-therapist': '語言治療師',
  'social-worker': '社工師',
  lawyer1: '律師一試', judicial: '司法特考三等',
  customs: '關務特考三等', 'civil-senior': '高考三等',
  police: '一般警察特考三等', police4: '一般警察特考四等',
}

function buildCacheKey(examId, qid) {
  return `exam:${examId}:${qid}`
}

function buildPrompt(q, examName) {
  const optText = Object.entries(q.options).map(([k, v]) => `${k}. ${v}`).join('\n')
  const correctOpt = q.options[q.answer] || ''
  const wrongNote = ''  // batch generation; no user_answer context
  const ragContextPromise = (async () => {
    if (!MEDICAL_EXAMS.has(q._examId)) return ''
    try {
      const queryText = (q.question + '\n' + correctOpt).slice(0, 200)
      const chunks = await rag.retrieve(queryText, { topK: 3, threshold: 0.55, language: null })
      if (!chunks.length) return ''
      return '\n【參考資料】（從醫學百科檢索）\n' + chunks.map((c, i) =>
        `${i + 1}. 《${c.metadata?.title || '醫學參考'}》：${c.content.replace(/\n+/g, ' ').slice(0, 220)}…`
      ).join('\n') + '\n（這些段落僅供參考，請優先依照題幹判斷。）\n'
    } catch { return '' }
  })()
  return Promise.resolve(ragContextPromise).then(ragContext => {
    return `你是一位臺灣${examName}的解題老師，用繁體中文回答。
${ragContext}
【作答原則】
1. 以題幹線索為核心：題目給的資訊（數據、病史、條文、案例）優先使用，不要憑空加細節。
2. 台灣考試標準：以台灣現行法規、官方指引、學會共識為準。
3. 不確定的精確數值（劑量、年限、金額、百分比、cutoff）要標「約」或「依指引」，不要編造具體數字。
4. 若知識點冷門或題幹資訊不足，誠實說「題幹資訊有限，常見答案是 X」，不要硬掰機制。
5. 避免無翻譯的艱澀外文；專有名詞中英並列。

科目：${q.subject_name || q.subject || ''}
題目：${q.question}

選項：
${optText}

正確答案：${q.answer}
${wrongNote}

請用以下格式回答（每段都要有，簡潔扼要）：

**✅ 為什麼答案是 ${q.answer}**
（從題幹線索出發，說明核心機制或概念，2-3句）

**❌ 排除其他選項**
（每個錯誤選項一句話說明為何不對）

**🧠 記憶關鍵字**
（給一個好記的口訣或記憶技巧）

**🏥 臨床應用**
（一句話說明這個知識點在臨床上的意義）`
  })
}

async function callGemini(prompt) {
  // Retry with exponential backoff on 429 (rate-limited). Vertex Gemini Flash
  // free tier has spiky throttling; up to ~10 attempts with backoff usually
  // eventually succeeds. Persistent failures bubble up.
  let lastErr
  for (let attempt = 0; attempt < 8; attempt++) {
    const tk = await auth.getAccessToken()
    const tokenStr = (typeof tk === 'string') ? tk : tk.token
    const url = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 60000)
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenStr}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
        }),
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      if (resp.status === 429) {
        const wait = Math.min(60000, 2000 * Math.pow(2, attempt))  // 2s, 4s, 8s, 16s, ...
        await new Promise(r => setTimeout(r, wait))
        lastErr = new Error('429 rate-limited')
        continue
      }
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '')
        throw new Error(`HTTP ${resp.status}: ${errBody.slice(0, 200)}`)
      }
      const data = await resp.json()
      return data.candidates?.[0]?.content?.parts?.[0]?.text || ''
    } catch (e) {
      clearTimeout(timer)
      lastErr = e
      if (attempt < 7) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
    }
  }
  throw lastErr
}

async function getExistingCacheKeys(examId, qids) {
  if (!supabase) return new Set()
  const keys = qids.map(id => buildCacheKey(examId, id))
  const existing = new Set()
  const CHUNK = 500
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK)
    const { data, error } = await supabase
      .from('ai_explanations')
      .select('cache_key')
      .in('cache_key', slice)
    if (!error && data) for (const r of data) existing.add(r.cache_key)
  }
  return existing
}

async function generateOne(q, examId, examName) {
  const prompt = await buildPrompt({ ...q, _examId: examId }, examName)
  const text = await callGemini(prompt)
  if (!text || text.length < 50) throw new Error('empty response')
  const cacheKey = buildCacheKey(examId, q.id)
  await supabase.from('ai_explanations').upsert({
    cache_key: cacheKey,
    explanation_md: text,
    model: VERTEX_MODEL,
    status: targetStatus,
    upvotes: 0,
    downvotes: 0,
    hit_count: 0,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'cache_key' })
}

async function processExam(examId) {
  const file = EXAM_FILES[examId]
  if (!file) { console.log(`[${examId}] unknown exam`); return 0 }
  const fp = path.join(BACKEND, file)
  if (!fs.existsSync(fp)) { console.log(`[${examId}] file missing`); return 0 }
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'))
  const arr = data.questions || data
  const candidates = arr.filter(q =>
    !q.incomplete && q.options &&
    Object.keys(q.options).length === 4 &&
    Object.values(q.options).every(o => o) &&
    q.answer && q.answer.length === 1 && q.id != null
  )
  if (!candidates.length) { console.log(`[${examId}] 0 candidates`); return 0 }

  const existing = await getExistingCacheKeys(examId, candidates.map(q => q.id))
  const todo = candidates.filter(q => !existing.has(buildCacheKey(examId, q.id))).slice(0, limit)
  console.log(`[${examId}] candidates=${candidates.length}, cached=${existing.size}, todo=${todo.length}`)
  if (dryRun || !todo.length) return 0

  const examName = EXAM_NAME[examId] || examId
  let done = 0, fail = 0, skipFail = 0
  const queue = [...todo]
  async function worker(i) {
    while (queue.length > 0) {
      const q = queue.shift()
      if (!q) break
      try {
        await generateOne(q, examId, examName)
        done++
      } catch (e) {
        fail++
        if (fail % 20 === 1) console.log(`  [${examId}] err sample: ${e.message.slice(0, 100)}`)
        if (fail > 50 && fail / (done + fail) > 0.5) {
          console.log(`  [${examId}] aborting — too many failures`)
          skipFail = queue.length
          queue.length = 0
        }
      }
      if ((done + fail) % 50 === 0) {
        process.stdout.write(`\r  [${examId}] ${done}/${todo.length} done, ${fail} fail`)
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)))
  console.log(`\n  [${examId}] ✓ ${done} generated, ${fail} failed${skipFail ? `, ${skipFail} skipped` : ''}`)
  return done
}

async function main() {
  if (!supabase) { console.error('Supabase not configured'); process.exit(1) }
  const exams = examFilter === 'all' ? Object.keys(EXAM_FILES) : examFilter.split(',')
  console.log(`[gen] mode=${dryRun ? 'DRY' : 'LIVE'} status=${targetStatus} concurrency=${concurrency} limit=${limit}/exam`)
  console.log(`[gen] exams: ${exams.join(', ')}`)
  let total = 0
  for (const examId of exams) {
    total += await processExam(examId)
  }
  console.log(`\n=== TOTAL GENERATED: ${total} ===`)
}

main().catch(e => { console.error(e); process.exit(1) })
