import { useState, useEffect } from 'react'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

export function useDailyMessage(name, level) {
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!name) return

    // Cache per player per calendar day (Taipei timezone)
    const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })
    const cacheKey = `daily-msg-${today}-${name}`
    const cached = localStorage.getItem(cacheKey)

    if (cached) {
      setMessage(cached)
      return
    }

    setLoading(true)
    let accumulated = ''

    fetch(`${BACKEND}/daily-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, level }),
    })
      .then(async res => {
        const reader = res.body.getReader()
        const decoder = new TextDecoder()

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const lines = decoder.decode(value).split('\n')
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const payload = line.slice(6)
            if (payload === '[DONE]') {
              setLoading(false)
              if (accumulated) localStorage.setItem(cacheKey, accumulated)
              return
            }
            try {
              const { text } = JSON.parse(payload)
              accumulated += text
              setMessage(accumulated)
            } catch {}
          }
        }
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [name])

  return { message, loading }
}
