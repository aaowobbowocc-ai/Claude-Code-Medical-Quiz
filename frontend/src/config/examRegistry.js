/**
 * Exam Registry — single source of truth for all exam configs.
 * Fetches from /exam-registry on first access, caches in memory + localStorage.
 * All components should read exam data from here instead of hardcoded constants.
 */

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
// Bump version to force-invalidate stale localStorage caches when the registry shape
// changes or new exams are added.
// v2: 中醫一/中醫二/獸醫師 added 4/13
// v3: taxonomy fields (category/subCategory/level/selectionType/persona/sharedBanks/uxHints)
//     + civil-service shell configs + sharedBanks metadata
// v4: civil shell exams totalQ 補齊 (junior/senior/elementary) — force refresh 字卡
// v5: 全考試 totalQ 同步實際題數（修正 doctor1/vet/nursing 等 17 套）
// v6: 新增 聽力師 audiologist 考試（111-113 年，885 題）
// v7: 聽力師擴充至 103-114（4023 題）
// v8: 新增 語言治療師 speech-therapist 考試（103-114 年，3643 題）
const CACHE_KEY = 'exam-registry-v8'
const CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours

let registry = null // in-memory cache
let fetchPromise = null
let sharedBanksCache = null
let sharedBanksFetchPromise = null

// Try loading from localStorage on module init
try {
  const cached = JSON.parse(localStorage.getItem(CACHE_KEY))
  if (cached && cached.ts && Date.now() - cached.ts < CACHE_TTL) {
    registry = cached.data
  }
} catch {}

/** Fetch registry from backend, with localStorage fallback */
async function fetchRegistry() {
  try {
    const res = await fetch(`${BACKEND}/exam-registry`)
    if (!res.ok) throw new Error(res.status)
    const data = await res.json()
    registry = data
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }))
    return data
  } catch {
    // If fetch fails and we have stale cache, use it
    if (registry) return registry
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY))
      if (cached?.data) { registry = cached.data; return registry }
    } catch {}
    return null
  }
}

/** Ensure registry is loaded (call early, e.g. in App mount) */
export function initRegistry() {
  if (!fetchPromise) fetchPromise = fetchRegistry()
  return fetchPromise
}

/** Get the full registry (all exams). Returns null if not loaded yet. */
export function getRegistry() {
  if (!registry) initRegistry()
  return registry
}

/** Get config for a specific exam. Synchronous — returns cached data or null. */
export function getExamConfig(examId) {
  const reg = getRegistry()
  return reg?.[examId] || null
}

/** Get all exam IDs */
export function getExamIds() {
  const reg = getRegistry()
  return reg ? Object.keys(reg) : []
}

// Preferred display order for exam picker
const EXAM_ORDER = [
  'doctor1', 'doctor2', 'dental1', 'dental2', 'pharma1', 'pharma2',
  'tcm1', 'tcm2', 'vet',
  'nursing', 'nutrition', 'social-worker', 'pt', 'ot', 'medlab', 'radiology', 'audiologist', 'speech-therapist',
  'lawyer1', 'judicial',
  'civil-senior', 'customs', 'police', 'police4',
  'civil-senior-general', 'civil-junior-general', 'civil-elementary-general',
  'driver-car', 'driver-moto',
]

// Category display metadata (Stage 1 persona cards)
const CATEGORY_META = {
  medical: {
    id: 'medical',
    icon: '🏥',
    name: '醫事人員',
    description: '醫學生、護理師、藥學生、醫檢師…',
    order: 1,
  },
  'law-professional': {
    id: 'law-professional',
    icon: '⚖️',
    name: '法律與司法',
    description: '律師、司法官、法學生',
    order: 2,
    pioneer: true,
  },
  'civil-service': {
    id: 'civil-service',
    icon: '🏛️',
    name: '公職人員',
    description: '高普考、初考、各類特考',
    order: 3,
    pioneer: true,
  },
  'common-subjects': {
    id: 'common-subjects',
    icon: '📚',
    name: '共同科目',
    description: '憲法、法緒、國文、英文（水庫練習）',
    order: 4,
    pioneer: true,
  },
  independent: {
    id: 'independent',
    icon: '🚗',
    name: '駕照考試',
    description: '汽車駕照、機車駕照',
    order: 5,
  },
}

// Legal subject tag whitelist (for hasLegalSubjectTag helper — AI explain warnings)
const LEGAL_SUBJECT_TAGS = new Set([
  'constitution', 'law_basics', 'admin_law', 'civil_law', 'criminal_law',
  'civil_procedure', 'criminal_procedure', 'commercial_law',
  'administrative_procedure', 'international_law', 'intellectual_property',
  'law_knowledge_combined', 'jurisprudence', 'legal_history',
  'evidence_law', 'enforcement_law',
  'comprehensive_law_1', 'comprehensive_law_2', 'comprehensive_law_3', 'comprehensive_law_4',
  'law_knowledge_english',
])

/** Get EXAM_TYPES-compatible array (for backward compat with gameStore consumers) */
export function getExamTypes() {
  const reg = getRegistry()
  if (!reg) return []
  const ids = Object.keys(reg)
  ids.sort((a, b) => {
    const ai = EXAM_ORDER.indexOf(a)
    const bi = EXAM_ORDER.indexOf(b)
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
  })
  return ids.map(id => {
    const cfg = reg[id]
    return {
      id: cfg.id,
      name: cfg.name,
      short: cfg.short,
      icon: cfg.icon,
      totalQ: cfg.totalQ,
      passScore: cfg.passScore,
      totalPoints: cfg.totalPoints,
      papers: cfg.papers,
    }
  })
}

/** Get tag display name for a given exam */
export function getTagName(examId, tag) {
  const cfg = getExamConfig(examId)
  if (!cfg) return tag
  return cfg.ui?.tagNames?.[tag] || tag
}

/** Get all tag names merged across all exams (backward compat) */
export function getAllTagNames() {
  const reg = getRegistry()
  if (!reg) return {}
  const merged = {}
  for (const cfg of Object.values(reg)) {
    Object.assign(merged, cfg.ui?.tagNames || {})
  }
  return merged
}

/** Get stage style (icon + color) for a tag */
export function getStageStyle(tag) {
  const reg = getRegistry()
  if (!reg) return { icon: '📝', color: '#64748B' }
  // Search all exams for the tag
  for (const cfg of Object.values(reg)) {
    const style = cfg.ui?.stageStyles?.[tag]
    if (style) return style
  }
  return { icon: '📝', color: '#64748B' }
}

/** Get all stage styles merged across all exams */
export function getAllStageStyles() {
  const reg = getRegistry()
  if (!reg) return {}
  const merged = {}
  for (const cfg of Object.values(reg)) {
    Object.assign(merged, cfg.ui?.stageStyles || {})
  }
  return merged
}

/** Get subject color by Chinese name (searches all exams) */
export function getSubjectColorFromRegistry(subjectName) {
  if (!subjectName) return null
  const reg = getRegistry()
  if (!reg) return null
  for (const cfg of Object.values(reg)) {
    const color = cfg.ui?.subjectColors?.[subjectName]
    if (color) return color
  }
  return null
}

/** Get SEO content for an exam */
export function getExamSeo(examId) {
  const cfg = getExamConfig(examId)
  return cfg?.seo || null
}

/** Get platform name for footer */
export function getPlatformName(examId) {
  const cfg = getExamConfig(examId)
  return cfg?.seo?.platformName || '國考知識王'
}

/** List of all categories in display order */
export function getExamCategories() {
  return Object.values(CATEGORY_META)
    .slice()
    .sort((a, b) => a.order - b.order)
}

/** Get all exams belonging to a given category, sorted by EXAM_ORDER */
export function getExamsByCategory(category) {
  const reg = getRegistry()
  if (!reg) return []
  const ids = Object.keys(reg).filter(id => reg[id]?.category === category)
  ids.sort((a, b) => {
    const ai = EXAM_ORDER.indexOf(a)
    const bi = EXAM_ORDER.indexOf(b)
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
  })
  return ids.map(id => reg[id])
}

/** Category metadata + live exam counts / question totals */
export function getCategoryMeta(category) {
  const meta = CATEGORY_META[category]
  if (!meta) return null
  const exams = getExamsByCategory(category)
  const examCount = exams.length
  const totalQ = exams.reduce((sum, e) => sum + (Number(e.totalQ) || 0), 0)
  return { ...meta, examCount, totalQ }
}

/** Union of persona tags across all exam configs */
export function getPersonaTags() {
  const reg = getRegistry()
  if (!reg) return []
  const set = new Set()
  for (const cfg of Object.values(reg)) {
    for (const tag of cfg.persona || []) set.add(tag)
  }
  return Array.from(set)
}

/** Fetch shared banks metadata from backend (async, cached in memory) */
export function getSharedBanks() {
  if (sharedBanksCache) return Promise.resolve(sharedBanksCache)
  if (sharedBanksFetchPromise) return sharedBanksFetchPromise
  sharedBanksFetchPromise = fetch(`${BACKEND}/shared-banks`)
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      sharedBanksCache = data?.banks || data || []
      return sharedBanksCache
    })
    .catch(() => {
      sharedBanksCache = []
      return sharedBanksCache
    })
  return sharedBanksFetchPromise
}

/** Check whether any tag in the given array is a legal subject (for AI explain warning) */
export function hasLegalSubjectTag(tags) {
  if (!Array.isArray(tags)) return false
  return tags.some(t => LEGAL_SUBJECT_TAGS.has(t))
}

const prefetched = new Set()
const BANK_VERSION_KEY = 'shared-bank-versions'

function getStoredVersions() {
  try { return JSON.parse(localStorage.getItem(BANK_VERSION_KEY) || '{}') } catch { return {} }
}

function saveStoredVersions(v) {
  try { localStorage.setItem(BANK_VERSION_KEY, JSON.stringify(v)) } catch {}
}

function notifySWInvalidate(bankId) {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.ready.then(reg => {
    reg.active?.postMessage({ type: 'invalidate-shared-bank', bankId })
  }).catch(() => {})
}

/** Called once on app init. Compares server bankVersions with stored ones;
 *  sends invalidation messages to the SW for any bank that has been updated. */
export function syncSharedBankVersions() {
  getSharedBanks().then(banks => {
    if (!banks?.length) return
    const stored = getStoredVersions()
    const next = { ...stored }
    let changed = false
    for (const b of banks) {
      const prev = stored[b.bankId]
      if (prev !== undefined && prev !== b.bankVersion) {
        notifySWInvalidate(b.bankId)
        prefetched.delete(b.bankId)
      }
      next[b.bankId] = b.bankVersion
      if (next[b.bankId] !== stored[b.bankId]) changed = true
    }
    if (changed) saveStoredVersions(next)
  }).catch(() => {})
}

/** Fire-and-forget: prefetch every shared bank declared by exams in this category.
 *  The Service Worker intercepts and persists the response in the shared-banks cache,
 *  so the user gets offline access the moment they open a reservoir-mode practice. */
export function prefetchCategorySharedBanks(category) {
  const exams = getExamsByCategory(category)
  const bankIds = new Set()
  for (const e of exams) {
    for (const b of e.sharedBanks || []) bankIds.add(b)
  }
  bankIds.forEach(bankId => {
    if (prefetched.has(bankId)) return
    prefetched.add(bankId)
    fetch(`${BACKEND}/shared-banks/${bankId}.json`).catch(() => {
      prefetched.delete(bankId)
    })
  })
}
