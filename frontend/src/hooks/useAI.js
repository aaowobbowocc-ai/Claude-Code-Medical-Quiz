import { useState, useCallback, useRef, useEffect } from 'react'
import { usePlayerStore } from '../store/gameStore'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const EXPLAIN_COST = 150
const REVIEW_COST = 100

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
async function streamPost(url, body, onChunk, onDone, onError, signal) {
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
    const { spendCoins } = usePlayerStore.getState()
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
    setLimitHit(false)
    setNotEnoughCoins(false)
    setLoading(true)
    incrementQuota()
    try {
      await streamPost(
        `${BACKEND}/explain`,
        { question: q.question, options: q.options, answer: q.answer,
          subject_name: q.subject_name || q.subject, user_answer: q.user_answer,
          question_id: q.id, exam: usePlayerStore.getState().exam || 'doctor1' },
        (chunk) => {
          // Drop chunks that arrive after the user moved on
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
      )
    } catch {
      if (activeQidRef.current === qid) setLoading(false)
    }
  }, [])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    activeQidRef.current = null
    setText('')
    setLoading(false)
    setLimitHit(false)
    setNotEnoughCoins(false)
  }, [])

  return { text, loading, limitHit, notEnoughCoins, explain, reset, remaining: getPersonalQuotaRemaining(), cost: EXPLAIN_COST }
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
