import { useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { usePlayerStore } from '../store/gameStore'

const LAST_SEEN_KEY = 'changelog-last-seen'

export default function SupportBar({ setSheet }) {
  const navigate = useNavigate()
  const darkMode = usePlayerStore(s => s.darkMode)
  const toggleDarkMode = usePlayerStore(s => s.toggleDarkMode)
  const soundMuted = usePlayerStore(s => s.soundMuted)
  const toggleSoundMuted = usePlayerStore(s => s.toggleSoundMuted)

  // Red-dot badge: show when the newest changelog entry is unseen.
  // Compares the latest entry's date string against localStorage and clears
  // the moment the user opens /changelog (Changelog.jsx writes the key).
  const [hasNew, setHasNew] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch('/changelog.json')
      .then(r => r.json())
      .then(data => {
        if (cancelled) return
        const latest = data?.[0]?.date
        if (!latest) return
        let lastSeen = null
        try { lastSeen = localStorage.getItem(LAST_SEEN_KEY) } catch {}
        if (!lastSeen || lastSeen < latest) setHasNew(true)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  return (
    <div className="flex items-center justify-center gap-2 mt-3 pb-1 flex-wrap">
      <button onClick={() => { setHasNew(false); navigate('/changelog') }}
              className="relative flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-purple-500 bg-purple-50 border border-purple-200 active:scale-95 transition-transform shadow-sm font-medium">
        📢 更新公告
        {hasNew && (
          <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center">
            <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75 animate-ping" />
            <span className="relative inline-flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-white text-[9px] font-black">!</span>
          </span>
        )}
      </button>
      <button onClick={() => setSheet('contact')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-gray-400 bg-white border border-gray-100 active:scale-95 transition-transform shadow-sm">
        💌 意見回饋
      </button>
      <button onClick={() => setSheet('donate')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-amber-500 bg-amber-50 border border-amber-200 active:scale-95 transition-transform shadow-sm font-medium">
        ☕ 贊助開發者
      </button>
      <button onClick={toggleDarkMode}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-gray-400 bg-white border border-gray-100 active:scale-95 transition-transform shadow-sm">
        {darkMode ? '☀️ 淺色' : '🌙 深色'}
      </button>
      <button onClick={toggleSoundMuted}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-gray-400 bg-white border border-gray-100 active:scale-95 transition-transform shadow-sm">
        {soundMuted ? '🔇 靜音' : '🔊 音效'}
      </button>
    </div>
  )
}
