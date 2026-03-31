import { useState, useCallback } from 'react'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

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
  const [text, setText]       = useState('')
  const [loading, setLoading] = useState(false)
  const [limitHit, setLimitHit] = useState(false)

  const explain = useCallback(async (q) => {
    setText('')
    setLimitHit(false)
    setLoading(true)
    try {
      await streamPost(
        `${BACKEND}/explain`,
        { question: q.question, options: q.options, answer: q.answer,
          subject_name: q.subject_name || q.subject, user_answer: q.user_answer },
        (chunk) => setText(t => t + chunk),
        () => setLoading(false),
        (msg) => { setLimitHit(true); setText(msg) },
      )
    } catch { setLoading(false) }
  }, [])

  const reset = () => { setText(''); setLimitHit(false) }

  return { text, loading, limitHit, explain, reset }
}

// Hook: review a full session
export function useReview() {
  const [text, setText]       = useState('')
  const [loading, setLoading] = useState(false)

  const review = useCallback(async (questions, mode = 'practice') => {
    setText('')
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

  return { text, loading, review }
}
