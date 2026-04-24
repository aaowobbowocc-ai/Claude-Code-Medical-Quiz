import { useState, useCallback, useRef, useEffect } from 'react'
import { usePlayerStore } from '../store/gameStore'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
// Pessimistic upfront charge — backend tells us the real price via the first SSE
// `meta` frame, and we refund the difference. This keeps the UX responsive (no
// pre-flight fetch) while still charging verified explanations for free.
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
const PERSONAL_LIMIT = 10
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
  // Meta from the first SSE frame — drives the pending/verified badge + vote UI
  const [meta, setMeta]         = useState(null) // { cacheKey, status, upvotes, downvotes, price }
  // Track the question id this hook is currently streaming for, so stale chunks
  // from a previous question can be dropped if the caller switched questions.
  const activeQidRef = useRef(null)
  const abortRef = useRef(null)

  // Cancel any in-flight stream when the component using this hook unmounts.
  useEffect(() => () => { abortRef.current?.abort() }, [])

  const explain = useCallback(async (q) => {
    if (getPersonalQuotaRemaining() <= 0) {
      setLimitHit(true)
      return
    }
    const { spendCoins, addCoins } = usePlayerStore.getState()
    // Reserve the full price; refund the difference once the server tells us
    // the real tier in the first meta frame.
    if (!spendCoins(EXPLAIN_COST)) {
      setNotEnoughCoins(true)
      return
    }
    // Cancel any previous stream so its trailing chunks don't bleed into this one.
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const qid = q?.id ?? Symbol('q')
    activeQidRef.current = qid

    setText('')
    setMeta(null)
    setLimitHit(false)
    setNotEnoughCoins(false)
    setLoading(true)
    incrementQuota()
    try {
      await streamPost(
        `${BACKEND}/explain`,
        { question: q.question, options: q.options, answer: q.answer,
          subject_name: q.subject_name || q.subject, user_answer: q.user_answer,
          question_id: q.id, exam: usePlayerStore.getState().exam || 'doctor1',
          shared_bank: q.isSharedBank ? q.sourceBankId : undefined },
        (chunk) => {
          if (activeQidRef.current !== qid) return
          setText(t => t + chunk)
        },
        () => {
          if (activeQidRef.current === qid) setLoading(false)
        },
        (msg) => {
          if (activeQidRef.current !== qid) return
          setLimitHit(true); setText(msg)
        },
        ctrl.signal,
        (m) => {
          if (activeQidRef.current !== qid) return
          setMeta(m)
          // Refund overage: we reserved EXPLAIN_COST, true price is m.price
          const refund = EXPLAIN_COST - (Number.isFinite(m?.price) ? m.price : EXPLAIN_COST)
          if (refund > 0) addCoins(refund)
        },
      )
    } catch {
      if (activeQidRef.current === qid) setLoading(false)
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
  }, [])

  return { text, loading, limitHit, notEnoughCoins, explain, reset, vote, meta, remaining: getPersonalQuotaRemaining(), cost: EXPLAIN_COST }
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
