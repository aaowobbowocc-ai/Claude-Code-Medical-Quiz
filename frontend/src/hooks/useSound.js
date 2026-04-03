import { useRef, useCallback } from 'react'

const cache = {}

function loadSound(src) {
  if (!cache[src]) {
    const audio = new Audio(src)
    audio.preload = 'auto'
    cache[src] = audio
  }
  return cache[src]
}

// Preload common sounds on first import
const PRELOAD = ['correct', 'wrong', 'coin', 'countdown', 'start']
if (typeof window !== 'undefined') {
  PRELOAD.forEach(name => loadSound(`/sounds/${name}.mp3`))
}

export function useSound() {
  const play = useCallback((name) => {
    try {
      const audio = loadSound(`/sounds/${name}.mp3`)
      const clone = audio.cloneNode()
      clone.volume = 0.7
      clone.play().catch(() => {})
    } catch {}
  }, [])

  return { play }
}
