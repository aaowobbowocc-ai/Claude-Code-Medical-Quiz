/**
 * Exam Registry — single source of truth for all exam configs.
 * Fetches from /exam-registry on first access, caches in memory + localStorage.
 * All components should read exam data from here instead of hardcoded constants.
 */

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
// Bump version to force-invalidate stale localStorage caches when the registry shape
// changes or new exams are added. (v2: 中醫一/中醫二/獸醫師 added 4/13 — clients with
// pre-4/13 cache were still serving the old list within the 24h TTL.)
const CACHE_KEY = 'exam-registry-v2'
const CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours

let registry = null // in-memory cache
let fetchPromise = null

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
  'nursing', 'nutrition', 'pt', 'ot', 'medlab',
]

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
