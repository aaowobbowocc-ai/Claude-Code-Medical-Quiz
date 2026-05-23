import { useState, useCallback, useRef, useEffect } from 'react'
import { usePlayerStore } from '../store/gameStore'
import { supabase } from '../lib/supabase'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
// Pessimistic upfront charge — backend tells us the real price via the first SSE
// `meta` frame, and we refund the difference. This keeps the UX responsive (no
// pre-flight fetch) while still charging verified explanations for free.
// Set to the *full price* so the worst case (cache miss, fresh LLM call) is
// covered without underflow. Must mirror backend EXPLAIN_PRICE_FULL.
const EXPLAIN_COST = 100
const REVIEW_COST = 300

// Stable per-device id for vote anti-cheat. Generated lazily on first read.
const DEVICE_ID_KEY = 'ai-device-id'
export function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY)
    if (!id) {
      id = (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36))
      localStorage.setItem(DEVICE_ID_KEY, id)
    }
    return id
  } catch {
    return 'anon-' + Math.random().toString(36).slice(2)
  }
}

// ── Per-device daily quota ──────────────────────────────────────
const PERSONAL_LIMIT = 20
const QUOTA_KEY = 'ai-explain-quota'

function getTaipeiDate() {
  return new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })
}

function getQuota() {
  try {
    const q = JSON.parse(localStorage.getItem(QUOTA_KEY) || '{}')
    if (q.date !== getTaipeiDate()) return { date: getTaipeiDate(), used: 0 }
    return q
  } catch { return { date: getTaipeiDate(), used: 0 } }
}

function incrementQuota() {
  const q = getQuota()
  q.used += 1
  try { localStorage.setItem(QUOTA_KEY, JSON.stringify(q)) } catch {}
}

export function getPersonalQuotaRemaining() {
  return Math.max(0, PERSONAL_LIMIT - getQuota().used)
}

// ── Per-question paid unlocks (localStorage, no auth required) ──────────
// Once a user pays for an explanation on a given question, record the question
// id locally so subsequent views (in any tab — practice / favorites / browse /
// review / mock) are free for THIS device. No cross-device sync — clearing
// localStorage or switching devices loses unlocks. Acceptable trade-off for
// not requiring registration; future improvement: when user binds an account,
// upload these IDs to Supabase for server-side tracking.
const UNLOCKS_KEY = 'ai-explain-unlocks'

function loadUnlocks() {
  try {
    const arr = JSON.parse(localStorage.getItem(UNLOCKS_KEY) || '[]')
    return new Set(Array.isArray(arr) ? arr.map(String) : [])
  } catch { return new Set() }
}

export function isExplainUnlocked(questionId) {
  if (questionId == null) return false
  return loadUnlocks().has(String(questionId))
}

function recordUnlock(questionId) {
  if (questionId == null) return
  const set = loadUnlocks()
  set.add(String(questionId))
  try { localStorage.setItem(UNLOCKS_KEY, JSON.stringify([...set])) } catch {}
}

export function getUnlockedCount() {
  return loadUnlocks().size
}

// Replace local set with a server-fetched superset (pulled at login). Keeps
// any local IDs the server didn't return — the sync endpoint should already
// have written them, but we don't want to drop unlocks if the round-trip dropped.
export function mergeUnlocks(serverIds) {
  if (!Array.isArray(serverIds)) return
  const set = loadUnlocks()
  for (const id of serverIds) set.add(String(id))
  try { localStorage.setItem(UNLOCKS_KEY, JSON.stringify([...set])) } catch {}
}

// One-time sync: upload local unlocks to backend, replace local with merged set.
// Idempotent — safe to call on every login. No-op if no user_id.
let syncInflight = null
export async function syncUnlocksToServer(userId) {
  if (!userId) return
  if (syncInflight) return syncInflight
  syncInflight = (async () => {
    const local = [...loadUnlocks()]
    try {
      // Pass auth token so backend can verify userId belongs to caller —
      // unauthenticated sync would let anyone unlock any user's questions.
      const session = await supabase?.auth.getSession().then(r => r?.data?.session).catch(() => null)
      if (!session?.access_token) { syncInflight = null; return }
      const res = await fetch(`${BACKEND}/ai/unlocks/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ userId, questionIds: local }),
      })
      if (res.ok) {
        const json = await res.json()
        if (Array.isArray(json.unlocks)) mergeUnlocks(json.unlocks)
      }
    } catch { /* offline: keep local set */ }
    finally { syncInflight = null }
  })()
  return syncInflight
}

// Stream text from a POST endpoint that returns SSE.
// Pass an AbortSignal so callers can cancel an in-flight stream.
// onMeta fires once with the meta frame (if the server sends one).
async function streamPost(url, body, onChunk, onDone, onError, signal, onMeta) {
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (e) {
    if (e.name === 'AbortError') return
    onError?.('network')
    onDone?.()
    return
  }
  if (!res.ok) {
    const json = await res.json().catch(() => ({}))
    onError?.(json.message || 'error')
    onDone?.()
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (signal?.aborted) return
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6)
        if (raw === '[DONE]') { onDone?.(); return }
        try {
          const parsed = JSON.parse(raw)
          // Mid-stream error frame — backend hit an LLM error after the SSE
          // headers were already sent. Surface it; otherwise the stream just
          // ends silently and the user sees a blank panel.
          if (parsed.error) { onError?.(parsed.error); onDone?.(); return }
          if (parsed.meta) onMeta?.(parsed.meta)
          if (parsed.text) onChunk(parsed.text)
        } catch {}
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') return
    throw e
  }
  onDone?.()
}

// Hook: explain a single question
export function useExplain() {
  const [text, setText]         = useState('')
  const [loading, setLoading]   = useState(false)
  const [limitHit, setLimitHit] = useState(false)
  const [notEnoughCoins, setNotEnoughCoins] = useState(false)
  // Generation failure (transient LLM error / empty response) — distinct from
  // limitHit (quota) so the UI can show a retry-able error instead of a blank.
  const [error, setError]       = useState(null)
  // Meta from the first SSE frame — drives the pending/verified badge + vote UI
  const [meta, setMeta]         = useState(null) // { cacheKey, status, upvotes, downvotes, price }
  // Track the question id this hook is currently streaming for, so stale chunks
  // from a previous question can be dropped if the caller switched questions.
  const activeQidRef = useRef(null)
  const abortRef = useRef(null)

  // Cancel any in-flight stream when the component using this hook unmounts.
  useEffect(() => () => { abortRef.current?.abort() }, [])

  const explain = useCallback(async (q) => {
    // Snapshot the auth user_id so the request can include it (server-side
    // unlock lookup + record). getSession is normally sync once hydrated, but
    // race with a timeout in case it hangs (slow network / Supabase issue).
    // 500ms is plenty for a hydrated session — if it doesn't return, we just
    // proceed without user_id (server falls back to anonymous flow).
    let userId = null
    if (supabase?.auth?.getSession) {
      try {
        const session = await Promise.race([
          supabase.auth.getSession().then(r => r?.data?.session || null),
          new Promise(resolve => setTimeout(() => resolve(null), 500)),
        ])
        userId = session?.user?.id || null
      } catch { /* swallow — anonymous flow */ }
    }
    const alreadyUnlocked = isExplainUnlocked(q?.id)

    // Per-question unlock + verified cache hits don't burn personal quota —
    // both come from cache with zero LLM cost. Quota only protects fresh /
    // pending generations.
    if (!alreadyUnlocked && getPersonalQuotaRemaining() <= 0) {
      setLimitHit(true)
      return
    }
    const { spendCoins, addCoins } = usePlayerStore.getState()
    // For unlocked questions, skip the upfront charge entirely — server will
    // confirm price=0 via meta frame. For new questions, reserve EXPLAIN_COST
    // (pessimistic) and refund the difference based on the server's true price.
    if (!alreadyUnlocked) {
      if (!spendCoins(EXPLAIN_COST)) {
        setNotEnoughCoins(true)
        return
      }
    }
    // Cancel any previous stream so its trailing chunks don't bleed into this one.
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const qid = q?.id ?? Symbol('q')
    activeQidRef.current = qid

    setText('')
    setMeta(null)
    setError(null)
    setLimitHit(false)
    setNotEnoughCoins(false)
    setLoading(true)

    // Per-stream closure state — lets onDone/onError decide whether to commit
    // the upfront coin charge or reverse it, based on how the stream ended.
    let effectivePrice = null   // resolved from the meta frame
    let serverUnlocked = false
    let receivedText = false
    let settled = false         // guards the terminal callbacks running twice

    // Refund whatever the user is still out of pocket. Before the meta frame
    // the full EXPLAIN_COST is reserved; after it, only effectivePrice remains.
    const refundCharge = () => {
      if (alreadyUnlocked) return
      const owed = effectivePrice == null ? EXPLAIN_COST : effectivePrice
      if (owed > 0) addCoins(owed)
    }

    try {
      await streamPost(
        `${BACKEND}/explain`,
        { question: q.question, options: q.options, answer: q.answer,
          subject_name: q.subject_name || q.subject, user_answer: q.user_answer,
          question_id: q.id, exam: usePlayerStore.getState().exam || 'doctor1',
          shared_bank: q.isSharedBank ? q.sourceBankId : undefined,
          incomplete: q.incomplete, disputed: q.disputed,
          has_image: !!(q.image_url || q.images?.length || q.option_images),
          user_id: userId },
        (chunk) => {
          if (activeQidRef.current !== qid) return
          receivedText = true
          setText(t => t + chunk)
        },
        () => {  // onDone
          if (settled || activeQidRef.current !== qid) return
          settled = true
          setLoading(false)
          if (receivedText) {
            // Success — commit the charge: burn quota for real paid gens and
            // record the unlock so future views are free for this device.
            if (effectivePrice > 0) incrementQuota()
            if ((effectivePrice > 0 || serverUnlocked) && q?.id != null) recordUnlock(q.id)
          } else {
            // Stream ended with no text and no error frame (e.g. the
            // connection dropped) — treat as a failure: refund and tell the user.
            refundCharge()
            setError('AI 解說沒有產生內容，金幣已退還，請再試一次。')
          }
        },
        (msg) => {  // onError
          if (settled || activeQidRef.current !== qid) return
          settled = true
          setLoading(false)
          // A real daily-limit message routes to the quota UI; anything else is
          // a transient generation failure — refund and show a retry-able error.
          if (/上限/.test(String(msg || ''))) {
            setLimitHit(true)
          } else {
            refundCharge()
            setError('AI 解說暫時無法產生，金幣已退還，請稍後再試一次。')
          }
        },
        ctrl.signal,
        (m) => {  // onMeta — fires for EVERY meta frame. Backend may send
          // multiple: the first carries pricing/cache info; a later one (when
          // Google Search grounding is on) carries citation URLs. Merge into
          // state so a later citations-only frame doesn't wipe cacheKey etc.
          if (activeQidRef.current !== qid) return
          setMeta(prev => ({ ...(prev || {}), ...m }))
          // Only resolve pricing on the frame that actually contains price /
          // alreadyUnlocked fields — citation-only frames have neither.
          const hasPricing = m?.price != null || m?.alreadyUnlocked != null || m?.cacheKey
          if (effectivePrice == null && hasPricing) {
            serverUnlocked = !!m?.alreadyUnlocked
            const isUnlocked = alreadyUnlocked || serverUnlocked
            effectivePrice = isUnlocked ? 0 : (Number.isFinite(m?.price) ? m.price : EXPLAIN_COST)
            setMeta(prev => ({ ...(prev || {}), price: effectivePrice, alreadyUnlocked: isUnlocked }))
            if (!alreadyUnlocked) {
              const overage = EXPLAIN_COST - effectivePrice
              if (overage > 0) addCoins(overage)
            }
          }
        },
      )
    } catch {
      if (!settled && activeQidRef.current === qid) {
        settled = true
        setLoading(false)
        refundCharge()
        setError('AI 解說發生錯誤，金幣已退還，請稍後再試一次。')
      }
    }
  }, [])

  // Vote on the currently-loaded explanation. Returns the updated tally or null.
  // localStorage dedupe key: `ai-votes:<cacheKey>` stores 1 | -1 per device.
  const vote = useCallback(async (value) => {
    if (!meta?.cacheKey) return null
    if (value !== 1 && value !== -1) return null
    const voteKey = `ai-votes:${meta.cacheKey}`
    try {
      if (localStorage.getItem(voteKey)) return null // already voted on this device
    } catch {}
    const { name } = usePlayerStore.getState()
    try {
      const res = await fetch(`${BACKEND}/ai/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cacheKey: meta.cacheKey,
          value,
          deviceId: getDeviceId(),
          userId: name || null,
        }),
      })
      if (!res.ok) return null
      const json = await res.json()
      try { localStorage.setItem(voteKey, String(value)) } catch {}
      // Merge server tally into meta so the UI updates instantly
      setMeta(m => m ? { ...m, status: json.status, upvotes: json.upvotes, downvotes: json.downvotes, price: json.price } : m)
      return json
    } catch {
      return null
    }
  }, [meta])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    activeQidRef.current = null
    setText('')
    setMeta(null)
    setLoading(false)
    setLimitHit(false)
    setNotEnoughCoins(false)
    setError(null)
  }, [])

  return { text, loading, limitHit, notEnoughCoins, error, explain, reset, vote, meta, remaining: getPersonalQuotaRemaining(), cost: EXPLAIN_COST }
}

// Hook: review a full session
export function useReview() {
  const [text, setText]       = useState('')
  const [loading, setLoading] = useState(false)
  const [notEnoughCoins, setNotEnoughCoins] = useState(false)

  const review = useCallback(async (questions, mode = 'practice') => {
    const { spendCoins } = usePlayerStore.getState()
    if (!spendCoins(REVIEW_COST)) {
      setNotEnoughCoins(true)
      return
    }
    setText('')
    setNotEnoughCoins(false)
    setLoading(true)
    try {
      await streamPost(
        `${BACKEND}/review`,
        { questions, mode },
        (chunk) => setText(t => t + chunk),
        () => setLoading(false),
      )
    } catch { setLoading(false) }
  }, [])

  return { text, loading, review, notEnoughCoins, cost: REVIEW_COST }
}
