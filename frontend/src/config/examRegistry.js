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
// v9: 新增 學測 gsat / 分科測驗 ast（college-entrance 類別）
// v10: 強制重抓 — civil-*-general 的 totalQ 已修正、聽力/語言補完到 6500+ 題
// v12: 全考試 totalQ 同步至 174,496 題（醫事 100% 完成、SEO 描述同步更新）
// v13: 新增 呼吸治療師 rt 考試（100-104 年紙本，4,320 題）
// v14: 全站 totalQ 同步至 180,527 題（含 RT 4,320 + 既有題庫累積補爬）
// v15: PT/OT 細分 14 個新 tag（pt_anatomy/physio/kinesio 等 + ot_history_theory 等）
// v16: 新增 臨床心理師 clinical-psychology 考試（113-114 年，479 題）
// v17: 新增 諮商心理師 counseling-psychology 考試（113-114 年，480 題）
// v18: 心理師補齊 100-114（臨床 5095/諮商 3827）+ 新增 驗光師/驗光生
// v19: 新增 公共衛生師 public-health 考試（111-114 年，957 題）
// v20: 新增 牙體技術師 dental-tech 考試（107-114 年，1574 題）
// v21: 新增 普考一般民政 civil-junior-civil-affairs（共用 bank + 地方自治概要，1822 題）
// v22: 新增 國營事業聯招 4 考試 state-mgmt/hr/finance/it（109-114 年，1198 題 + 英文共用 240）
// v23: civil-senior 改 shell（高考三等一般行政），重爬修正舊 pdfjs 切錯選項的污染題庫
// v24: judicial 改 shell（司法特考三等），重爬法學知識與英文修正污染
// v25: 新增 中華郵政 post-indoor/post-outdoor 考試（專業職二內外勤，104-114 年，1098 題）
// v26: judicial 改歸「法律與司法」類別；移除空的「共同科目」身分類別
// v27: 新增 台鐵招考 railway-transport/railway-admin 考試（鐵路特考佐級運輸營業/事務管理，100-112 年，4,730 題）
const CACHE_KEY = 'exam-registry-v27'
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
  'nursing', 'nutrition', 'social-worker', 'pt', 'ot', 'medlab', 'radiology', 'audiologist', 'speech-therapist', 'clinical-psychology', 'counseling-psychology', 'public-health', 'optometrist', 'optometrist-junior', 'dental-tech',
  'lawyer1', 'judicial',
  'civil-senior', 'customs', 'police', 'police4',
  'civil-senior-general', 'civil-junior-general', 'civil-junior-civil-affairs', 'civil-elementary-general',
  'state-mgmt', 'state-hr', 'state-finance', 'state-it',
  'post-indoor', 'post-outdoor',
  'railway-transport', 'railway-admin',
  'driver-car', 'driver-moto',
  'gsat', 'ast',
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
  },
  'civil-service': {
    id: 'civil-service',
    icon: '🏛️',
    name: '公職人員',
    description: '高普考、初考、各類特考',
    order: 3,
  },
  'state-enterprise': {
    id: 'state-enterprise',
    icon: '⚡',
    name: '國營事業',
    description: '台電、中油、台水、台糖聯合招考、中華郵政、台鐵招考',
    order: 4,
  },
  // 共同科目不是「身分」、底下也無考試 → 不列入身分選單。
  // 共同科練習仍由各考試的 sharedBanks（🌊 共同科題庫）提供。
  independent: {
    id: 'independent',
    icon: '🚗',
    name: '駕照考試',
    description: '汽車駕照、機車駕照',
    order: 5,
  },
  'college-entrance': {
    id: 'college-entrance',
    icon: '🎓',
    name: '大學入學',
    description: '學科能力測驗（學測）、分科測驗',
    order: 6,
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
