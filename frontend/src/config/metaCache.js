/**
 * Shared meta cache — stale-while-revalidate.
 *
 * /meta (per-exam metadata: years/sessions/stages/papers) is heavy and
 * was re-fetched by every page (Practice/Lobby/Map/Browse) on exam switch.
 * This module caches in memory + localStorage so repeat switches are instant.
 */

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const CACHE_TTL = 60 * 60 * 1000 // 1 hour (matches backend Cache-Control)
const LS_PREFIX = 'exam-meta-v1:'

const mem = new Map() // examId -> { data, ts }
const inflight = new Map() // examId -> Promise

function readLS(examId) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + examId)
    if (!raw) return null
    const obj = JSON.parse(raw)
    if (!obj || !obj.ts || !obj.data) return null
    return obj
  } catch { return null }
}

function writeLS(examId, data) {
  try {
    localStorage.setItem(LS_PREFIX + examId, JSON.stringify({ ts: Date.now(), data }))
  } catch {}
}

/** Sync read — returns cached data immediately if any, else null. Does NOT fetch. */
export function getMetaSync(examId) {
  const cached = mem.get(examId)
  if (cached) return cached.data
  const fromLS = readLS(examId)
  if (fromLS) {
    mem.set(examId, fromLS)
    return fromLS.data
  }
  return null
}

/**
 * Async get — returns cached if fresh, otherwise fetches.
 * If stale cache exists, returns it AND triggers background revalidation.
 */
export function getMeta(examId) {
  const cached = mem.get(examId) || readLS(examId)
  const fresh = cached && Date.now() - cached.ts < CACHE_TTL

  if (fresh) {
    if (!mem.has(examId)) mem.set(examId, cached)
    return Promise.resolve(cached.data)
  }

  // Deduplicate concurrent fetches
  if (inflight.has(examId)) return inflight.get(examId)

  const p = fetch(`${BACKEND}/meta?exam=${examId}`)
    .then(r => r.json())
    .then(data => {
      mem.set(examId, { data, ts: Date.now() })
      writeLS(examId, data)
      return data
    })
    .catch(err => {
      // On network error, fall back to stale cache if available
      if (cached) return cached.data
      throw err
    })
    .finally(() => { inflight.delete(examId) })

  inflight.set(examId, p)

  // If we have stale cache, return it immediately for snappy UI
  // while fetch continues in background
  if (cached) return Promise.resolve(cached.data)
  return p
}

/** Prefetch in background — fire-and-forget, no return value. */
export function prefetchMeta(examId) {
  if (!examId) return
  const cached = mem.get(examId) || readLS(examId)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return
  getMeta(examId).catch(() => {})
}
