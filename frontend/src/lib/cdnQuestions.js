// CDN questions loader — pulls full exam JSON from jsDelivr (GitHub raw via CDN)
// and caches in IndexedDB. Replaces backend /questions/* API calls for read-only data.
// Render bandwidth → ~0 (CDN serves all reads).
//
// Cache key includes a version stamp; bump CACHE_VERSION to force re-download.

const CDN_BASE = 'https://cdn.jsdelivr.net/gh/aaowobbowocc-ai/Claude-Code-Medical-Quiz@master/backend'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24h
const CACHE_VERSION = 1
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
  'civil-senior': 'questions-civil-senior.json',
  customs: 'questions-customs.json',
  judicial: 'questions-judicial.json',
  lawyer1: 'questions-lawyer1.json',
  police: 'questions-police.json',
  police4: 'questions-police4.json',
  'driver-car': 'questions-driver-car.json',
  'driver-moto': 'questions-driver-moto.json',
}

// In-memory cache (per page-load)
const memCache = new Map()

// ── IndexedDB helpers ──────────────────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGet(key) {
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly')
      const req = tx.objectStore(DB_STORE).get(key)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => reject(req.error)
    })
  } catch { return null }
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
export async function loadExamQuestions(examId) {
  if (memCache.has(examId)) return memCache.get(examId)

  const file = EXAM_FILES[examId]
  if (!file) throw new Error(`No CDN file mapped for exam ${examId}`)

  const cacheKey = `${examId}:v${CACHE_VERSION}`
  // Try IDB cache (silent on any failure)
  try {
    const cached = await idbGet(cacheKey)
    if (cached && cached.questions && Date.now() - cached.ts < CACHE_TTL_MS) {
      memCache.set(examId, cached.questions)
      return cached.questions
    }
  } catch { /* ignore IDB errors */ }

  const url = `${CDN_BASE}/${file}`
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

// ── Filter / sort helpers (mirror backend questions-api.js logic) ──────────

function isSingleAnswer(q) {
  return q.answer && q.answer.length === 1 && q.options && q.options[q.answer] && !q.incomplete
}

// doctor1 paper-constraint (mirror of backend)
const DOCTOR1_MED1_TAGS = new Set(['anatomy', 'embryology', 'histology', 'physiology', 'biochemistry'])
const DOCTOR1_MED2_TAGS = new Set(['microbiology', 'parasitology', 'public_health', 'pharmacology', 'pathology'])
function doctor1PaperOK(q, tag) {
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
export async function getRandomQuestions(examId, { stageId, count = 50, stages = [], sharedQuestions = [] } = {}) {
  const own = await loadExamQuestions(examId)
  let pool = sharedQuestions.length > 0 ? [...own, ...sharedQuestions] : own
  pool = pool.filter(isSingleAnswer)

  const sidStr = stageId != null ? String(stageId) : ''
  const tag = sidStr && sidStr !== '0'
    ? stages.find(s => String(s.id) === sidStr)?.tag
    : null
  if (tag && tag !== 'all') {
    pool = pool.filter(q =>
      (q.paper_id === tag ||
       q.subject_tag === tag ||
       (Array.isArray(q.subject_tags) && q.subject_tags.includes(tag)))
      && doctor1PaperOK(q, tag)
    )
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
  if (subject_tag) list = list.filter(x => x.subject_tag === subject_tag && doctor1PaperOK(x, subject_tag))
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
    if (!exams[key]) exams[key] = { roc_year: q.roc_year, session: q.session, papers: {} }
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
//   Returns N random single-answer questions, optionally filtered to a paper subject.
export async function getRandomPaper(examId, { count = 100, subject } = {}) {
  const pool = await loadExamQuestions(examId)
  let valid = pool.filter(isSingleAnswer)
  if (subject) valid = valid.filter(q => q.subject === subject)
  const target = parseInt(count) || 100
  const picked = shuffle(valid).slice(0, target)
  return { total: picked.length, questions: picked, mode: 'random' }
}
