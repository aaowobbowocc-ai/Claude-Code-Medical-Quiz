// CDN questions loader — pulls full exam JSON from jsDelivr (GitHub raw via CDN)
// and caches in IndexedDB. Replaces backend /questions/* API calls for read-only data.
// Render bandwidth → ~0 (CDN serves all reads).
//
// Cache key includes a version stamp; bump CACHE_VERSION to force re-download.

const CDN_BASE = 'https://cdn.jsdelivr.net/gh/aaowobbowocc-ai/Claude-Code-Medical-Quiz@master/backend'
// GitHub raw 永遠是最新（無 jsDelivr 的 ~12h edge 快取）。forceFresh（錯題夾 re-hydrate）改用此來源，
// 確保題目修正後立即拿到最新版，不受 jsDelivr edge 快取/purge 傳播延遲影響。
const RAW_BASE = 'https://raw.githubusercontent.com/aaowobbowocc-ai/Claude-Code-Medical-Quiz/master/backend'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24h
// v3 (2026-05-15): doctor2/tcm/nursing 102 大量題幹+選項重抽，強制刷新 jsDelivr + IndexedDB cache
// v4 (2026-06-08): 護理112精神社區整卷校正、speech/audio位移、PUA/答案修正等大量更新，強制刷新
// v5 (2026-06-11): 補齊護理師 112/113/114 年第三次國考（746 題），強制刷新讓新場次顯示
// v6 (2026-06-12): 強制失效 stale 的 nursing v5 快取（部分使用者在 propagation 窗口抓到舊內容→第三次/修正不顯示）
// v7 (2026-06-14): 全平台 1648 題「承上題」併入題組情境，隨機練習可單獨作答，強制刷新
// v8 (2026-06-28): 本季大量題目修正（含護理產兒科整卷答案校正、律師複選、多份含圖題補圖等），強制刷新讓舊快取使用者收到
// v9 (2026-07-05): 語言治療師 ~1044 題選項還原、營養師 163 題選項重複修正、醫檢/醫師大量答案與補圖，強制刷新
// v38 (2026-07-24): 醫檢血球圖補圖(105-1#76漿細胞/103-1#80承上)
const CACHE_VERSION = 42
const DB_NAME = 'questions-cache'
const DB_STORE = 'exams'

// ── Map exam id → questions JSON file (mirror of backend exam-configs) ─────
const EXAM_FILES = {
  doctor1: 'questions.json',
  doctor2: 'questions-doctor2.json',
  dental1: 'questions-dental1.json',
  dental2: 'questions-dental2.json',
  pharma1: 'questions-pharma1.json',
  pharma2: 'questions-pharma2.json',
  tcm1: 'questions-tcm1.json',
  tcm2: 'questions-tcm2.json',
  nursing: 'questions-nursing.json',
  nutrition: 'questions-nutrition.json',
  medlab: 'questions-medlab.json',
  pt: 'questions-pt.json',
  ot: 'questions-ot.json',
  radiology: 'questions-radiology.json',
  vet: 'questions-vet.json',
  'social-worker': 'questions-social-worker.json',
  audiologist: 'questions-audiologist.json',
  'speech-therapist': 'questions-speech-therapist.json',
  'clinical-psychology': 'questions-clinical-psychology.json',
  'counseling-psychology': 'questions-counseling-psychology.json',
  'public-health': 'questions-public-health.json',
  'dental-tech': 'questions-dental-tech.json',
  optometrist: 'questions-optometrist.json',
  'optometrist-junior': 'questions-optometrist-junior.json',
  customs: 'questions-customs.json',
  lawyer1: 'questions-lawyer1.json',
  police: 'questions-police.json',
  police4: 'questions-police4.json',
  'driver-car': 'questions-driver-car.json',
  'driver-moto': 'questions-driver-moto.json',
  gsat: 'questions-gsat.json',
  ast: 'questions-ast.json',
  rt: 'questions-rt.json',
  'state-mgmt': 'questions-state-mgmt.json',
  'state-hr': 'questions-state-hr.json',
  'state-finance': 'questions-state-finance.json',
  'state-it': 'questions-state-it.json',
  'post-indoor': 'questions-post-indoor.json',
  'post-outdoor': 'questions-post-outdoor.json',
  'railway-transport': 'questions-railway-transport.json',
  'railway-admin': 'questions-railway-admin.json',
  'teacher-secondary': 'questions-teacher-secondary.json',
  'teacher-elementary': 'questions-teacher-elementary.json',
  'teacher-kindergarten': 'questions-teacher-kindergarten.json',
  'teacher-special': 'questions-teacher-special.json',
  'teacher-special-gifted': 'questions-teacher-special-gifted.json',
}

// In-memory cache (per page-load)
const memCache = new Map()

// ── IndexedDB helpers ──────────────────────────────────────────────────────
// All IDB ops race against a 1.5s timeout — IDB can hang indefinitely if
// another tab holds a write lock or storage is corrupt. On timeout, we treat
// it as a cache miss and proceed to CDN fetch.
const IDB_TIMEOUT = 1500

function withTimeout(promise, ms, fallback = null) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms))
  ])
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('IDB blocked'))
  })
}

async function idbGet(key) {
  return withTimeout((async () => {
    try {
      const db = await openDB()
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readonly')
        const req = tx.objectStore(DB_STORE).get(key)
        req.onsuccess = () => resolve(req.result || null)
        req.onerror = () => reject(req.error)
      })
    } catch { return null }
  })(), IDB_TIMEOUT, null)
}

async function idbPut(key, value) {
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite')
      tx.objectStore(DB_STORE).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch { /* IDB blocked → silent skip cache */ }
}

// ── Public API ─────────────────────────────────────────────────────────────

export function isExamSupportedByCDN(examId) {
  return !!EXAM_FILES[examId]
}

// Fetch with a hard timeout. Falls back via AbortController.
async function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

// Return full questions array for an exam. Caches in memory + IDB for 24h.
// Throws if exam unknown or fetch fails (caller should fall back to backend).
export async function loadExamQuestions(examId, { forceFresh = false } = {}) {
  if (!forceFresh && memCache.has(examId)) return memCache.get(examId)

  const file = EXAM_FILES[examId]
  if (!file) throw new Error(`No CDN file mapped for exam ${examId}`)

  const cacheKey = `${examId}:v${CACHE_VERSION}`
  // Try IDB cache (silent on any failure). forceFresh 跳過快取讀取，直接抓網路最新版
  // （用於錯題夾 re-hydrate：題目修正後同版本快取仍是舊的，必須繞過）。
  if (!forceFresh) try {
    const cached = await idbGet(cacheKey)
    if (cached && cached.questions && Date.now() - cached.ts < CACHE_TTL_MS) {
      memCache.set(examId, cached.questions)
      return cached.questions
    }
  } catch { /* ignore IDB errors */ }

  // Cache-bust query string forces jsDelivr edge to fetch fresh from GitHub
  // when @master ref is updated. CACHE_VERSION bump invalidates this batch.
  // forceFresh 另加時戳，連瀏覽器 HTTP 快取一起繞過（題目修正後同版本 URL 仍可能命中瀏覽器快取）。
  const url = forceFresh
    ? `${RAW_BASE}/${file}?_=${Date.now()}`            // 永遠最新（GitHub raw）
    : `${CDN_BASE}/${file}?v=${CACHE_VERSION}`
  const r = await fetchWithTimeout(url, 8000)
  if (!r.ok) throw new Error(`CDN fetch failed: ${r.status}`)
  const data = await r.json()
  const questions = Array.isArray(data) ? data : (data.questions || [])

  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error(`CDN returned empty/invalid data for ${examId}`)
  }

  memCache.set(examId, questions)
  // Fire-and-forget cache write
  idbPut(cacheKey, { ts: Date.now(), questions }).catch(() => {})

  return questions
}

// 錯題夾 re-hydrate：用最新題庫覆蓋本地存的舊題目副本，避免顯示已修正前的壞版本。
// ⚠️ 必須「依 (考試, id) 對應」——不同考試的題目 id 會撞號（醫學/法律/英文同 id 不同題），
// 若用全域 id map 會把某科錯題換成別科同 id 的題目（已造成錯題夾汙染，2026-06-21 修）。
// 改為每個考試各自一份 id map，每題只在「它自己的考試」(examId 或 fallback) 裡查。
// 保留錯題夾欄位（myAnswer/addedAt/examId）。examId 缺則用 fallbackExamId。
export async function rehydrateWrong(wrongQs, fallbackExamId) {
  if (!Array.isArray(wrongQs) || wrongQs.length === 0) return wrongQs || []
  const examIds = new Set()
  for (const q of wrongQs) {
    const e = (q && q.examId) || fallbackExamId
    if (e && EXAM_FILES[e]) examIds.add(e)
  }
  if (examIds.size === 0) return wrongQs
  const byExam = {} // examId -> Map(id -> question)，各考試獨立、不混淆
  await Promise.all([...examIds].map(async (e) => {
    try {
      // forceFresh：繞過同版本的舊快取，確保抓到題目修正後的最新版
      const list = await loadExamQuestions(e, { forceFresh: true })
      const m = new Map()
      for (const q of list) if (q && q.id != null) m.set(String(q.id), q)
      byExam[e] = m
    } catch {}
  }))
  return wrongQs.map(wq => {
    const e = (wq && wq.examId) || fallbackExamId
    const fresh = (e && byExam[e] && wq && wq.id != null) ? byExam[e].get(String(wq.id)) : null
    return fresh
      ? { ...wq, ...fresh, myAnswer: wq.myAnswer, addedAt: wq.addedAt, examId: e }
      : wq
  })
}

// ── Filter / sort helpers (mirror backend questions-api.js logic) ──────────

function isSingleAnswer(q) {
  return q.answer && q.answer.length === 1 && q.options && q.options[q.answer] && !q.incomplete
}

// doctor1 paper-constraint (mirror of backend)
const DOCTOR1_MED1_TAGS = new Set(['anatomy', 'embryology', 'histology', 'physiology', 'biochemistry'])
const DOCTOR1_MED2_TAGS = new Set(['microbiology', 'parasitology', 'public_health', 'pharmacology', 'pathology'])
function doctor1PaperOK(q, tag, examId) {
  // Only enforce for doctor1: tags like 'pathology' / 'physiology' are also
  // legitimate stage tags in medlab/nursing/etc, which must NOT be filtered
  // by 醫學(一)/醫學(二) subject names.
  if (examId !== 'doctor1') return true
  if (q.roc_year && parseInt(q.roc_year) < 101) return true
  if (DOCTOR1_MED1_TAGS.has(tag)) return !q.subject || q.subject === '醫學(一)'
  if (DOCTOR1_MED2_TAGS.has(tag)) return !q.subject || q.subject === '醫學(二)'
  return true
}

function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Replace `/questions/random?stage_id=N&count=10&exam=X[&mode=reservoir]`
//   stages: array from exam config (id+tag)
//   sharedQuestions: optional array merged in for mode=reservoir
export async function getRandomQuestions(examId, { stageId, count = 50, stages = [], sharedQuestions = [], year = '' } = {}) {
  const own = await loadExamQuestions(examId)
  let pool = sharedQuestions.length > 0 ? [...own, ...sharedQuestions] : own
  pool = pool.filter(isSingleAnswer)

  // stageId 可為單科 "3" 或多科複選 "3,5,7"（回饋：練習區科目複選）
  const sids = String(stageId ?? '').split(',').map(s => s.trim()).filter(s => s && s !== '0')
  const tags = sids
    .map(sid => stages.find(s => String(s.id) === sid)?.tag)
    .filter(t => t && t !== 'all')
  if (tags.length > 0 && !sids.includes('0')) {
    pool = pool.filter(q =>
      tags.some(tag =>
        (q.paper_id === tag ||
         q.subject_tag === tag ||
         (Array.isArray(q.subject_tags) && q.subject_tags.includes(tag)))
        && doctor1PaperOK(q, tag, examId)
      )
    )
  }

  // 自主練習年份篩選（回饋）：year 可為單一或逗號多年份字串（複選），空=全部
  if (year) {
    const ys = String(year).split(',').map(s => s.trim()).filter(Boolean)
    if (ys.length) pool = pool.filter(q => ys.includes(String(q.roc_year)))
  }

  const target = parseInt(count) || 50
  const picked = shuffle(pool).slice(0, target)
  return { total: pool.length, questions: picked }
}

// Replace `/questions?exam=X[&year=Y&session=S&subject_tag=T&q=...&page=N&limit=20]` (browse)
export async function browseQuestions(examId, { year, session, subject_tag, q, page = 1, limit = 20 } = {}) {
  let list = await loadExamQuestions(examId)
  if (year)        list = list.filter(x => x.roc_year === year)
  if (session)     list = list.filter(x => x.session === session)
  if (subject_tag) list = list.filter(x => x.subject_tag === subject_tag && doctor1PaperOK(x, subject_tag, examId))
  if (q)           list = list.filter(x => x.question.includes(q) || Object.values(x.options || {}).some(o => o.includes(q)))
  const total = list.length
  const start = (parseInt(page) - 1) * parseInt(limit)
  return { total, page: parseInt(page), limit: parseInt(limit), questions: list.slice(start, start + parseInt(limit)) }
}

// Replace `/questions/exam-years?exam=X` — aggregated year/session/paper structure
export async function getExamYears(examId, { paperOrder = [] } = {}) {
  const questions = await loadExamQuestions(examId)
  const exams = {}
  for (const q of questions) {
    const key = `${q.roc_year}_${q.session}`
    if (!exams[key]) exams[key] = { roc_year: q.roc_year, session: q.session, exam_type: q.exam_type, papers: {} }
    if (!exams[key].papers[q.subject]) exams[key].papers[q.subject] = {}
    const tag = q.subject_tag
    exams[key].papers[q.subject][tag] = (exams[key].papers[q.subject][tag] || 0) + 1
  }
  function paperSortIdx(name) {
    const idx = paperOrder.indexOf(name)
    return idx >= 0 ? idx : 999
  }
  return Object.values(exams)
    .map(e => ({
      roc_year: e.roc_year,
      session: e.session,
      label: `${e.roc_year}年${e.session}`,
      papers: Object.entries(e.papers).map(([name, dist]) => ({
        name,
        total: Object.values(dist).reduce((a, b) => a + b, 0),
        distribution: dist,
      })).sort((a, b) => paperSortIdx(a.name) - paperSortIdx(b.name)),
    }))
    .sort((a, b) => b.roc_year.localeCompare(a.roc_year) || b.session.localeCompare(a.session))
}

// Replace `/questions/exam?exam=X&year=Y&session=S&subject=...` (historical mode)
//   Returns ALL questions (including multi-answer/voided) for authentic exam sim,
//   sorted by question number.
export async function getHistoricalPaper(examId, { year, session, subject } = {}) {
  const pool = await loadExamQuestions(examId)
  const filtered = pool.filter(q => q.roc_year === year && q.session === session && q.subject === subject)
  const ordered = [...filtered].sort((a, b) => (a.number || 0) - (b.number || 0))
  return { total: ordered.length, questions: ordered, mode: 'historical' }
}

// Replace `/questions/exam?exam=X&count=N&subject=S` (random mode without stages)
//   Returns N random single-answer questions, optionally filtered to a paper subject
//   and/or a set of ROC years (years: string[] — empty/undefined = all years).
export async function getRandomPaper(examId, { count = 100, subject, years } = {}) {
  const pool = await loadExamQuestions(examId)
  let valid = pool.filter(isSingleAnswer)
  if (subject) valid = valid.filter(q => q.subject === subject)
  if (Array.isArray(years) && years.length) {
    const yset = new Set(years.map(String))
    valid = valid.filter(q => yset.has(q.roc_year))
  }
  const target = parseInt(count) || 100
  const picked = shuffle(valid).slice(0, target)
  return { total: picked.length, questions: picked, mode: 'random' }
}
