import { useEffect, useState } from 'react'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const CACHE_KEY = 'cumulative-stats-v1'
const CACHE_TTL = 5 * 60 * 1000 // 5 min

function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY))
    if (c && Date.now() - c.ts < CACHE_TTL) return c.data
  } catch {}
  return null
}

function fmt(n) {
  if (n == null) return '—'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 10_000) return Math.round(n / 1000) + 'K'
  return n.toLocaleString('zh-TW')
}

export default function CumulativeStatsBar({ compact = false }) {
  const [data, setData] = useState(loadCache())

  useEffect(() => {
    let cancelled = false
    fetch(`${BACKEND}/cumulative-stats`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled || !d) return
        setData(d)
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: d })) } catch {}
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  if (!data) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-4 grid grid-cols-3 gap-3 animate-pulse">
        {[0, 1, 2].map(i => (
          <div key={i} className="text-center">
            <div className="h-6 bg-gray-100 rounded mb-1" />
            <div className="h-3 bg-gray-50 rounded w-3/4 mx-auto" />
          </div>
        ))}
      </div>
    )
  }

  const items = [
    { num: fmt(data.totalQuestions), lbl: '收錄題庫' },
    { num: fmt(data.questionsAnswered), lbl: '累計解題次數' },
    { num: fmt(data.examsCount), lbl: '考試類別' },
  ]

  if (compact) {
    return (
      <div className="flex items-center justify-around bg-white rounded-2xl border border-gray-100 px-3 py-2.5">
        {items.map((it, i) => (
          <div key={i} className="text-center">
            <div className="text-lg font-bold text-medical-blue leading-tight">{it.num}</div>
            <div className="text-[10px] text-gray-500 mt-0.5">{it.lbl}</div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="bg-gradient-to-br from-blue-50 via-teal-50 to-cyan-50 rounded-2xl border border-blue-100 p-4">
      <p className="text-[10px] font-semibold text-medical-blue tracking-wide text-center mb-2">📊 平台累積使用</p>
      <div className="grid grid-cols-3 gap-3">
        {items.map((it, i) => (
          <div key={i} className="text-center">
            <div className="text-xl font-extrabold text-medical-dark leading-tight">{it.num}</div>
            <div className="text-[11px] text-gray-500 mt-0.5">{it.lbl}</div>
          </div>
        ))}
      </div>
      {data.gamesPlayed > 0 || data.aiExplains > 0 ? (
        <div className="mt-3 pt-3 border-t border-blue-100 flex items-center justify-around text-[11px] text-gray-500">
          {data.gamesPlayed > 0 && <span>🎮 {fmt(data.gamesPlayed)} 場對戰</span>}
          {data.aiExplains > 0 && <span>🤖 {fmt(data.aiExplains)} 次 AI 解說</span>}
        </div>
      ) : null}
    </div>
  )
}
