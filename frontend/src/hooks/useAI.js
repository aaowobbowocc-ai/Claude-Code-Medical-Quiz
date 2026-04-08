import { useState, useCallback } from 'react'
import { usePlayerStore } from '../store/gameStore'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const EXPLAIN_COST = 200
const REVIEW_COST = 200

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

// Stream text from a POST endpoint that returns SSE
async function streamPost(url, body, onChunk, onDone, onError) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const json = await res.json().catch(() => ({}))
    onError?.(json.message || 'error')
    onDone?.()
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
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
  onDone?.()
}

// Hook: explain a single question
export function useExplain() {
  const [text, setText]         = useState('')
  const [loading, setLoading]   = useState(false)
  const [limitHit, setLimitHit] = useState(false)
  const [notEnoughCoins, setNotEnoughCoins] = useState(false)

  const explain = useCallback(async (q) => {
    if (getPersonalQuotaRemaining() <= 0) {
      setLimitHit(true)
      return
    }
    // Check coins
    const { spendCoins } = usePlayerStore.getState()
    if (!spendCoins(EXPLAIN_COST)) {
      setNotEnoughCoins(true)
      return
    }
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
        (chunk) => setText(t => t + chunk),
        () => setLoading(false),
        (msg) => { setLimitHit(true); setText(msg) },
      )
    } catch { setLoading(false) }
  }, [])

  const reset = () => { setText(''); setLimitHit(false); setNotEnoughCoins(false) }

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
