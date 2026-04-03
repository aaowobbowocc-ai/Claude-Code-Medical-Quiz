import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const MEDALS = ['🥇', '🥈', '🥉']

export default function Leaderboard() {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [week, setWeek] = useState('')
  const [loading, setLoading] = useState(true)

  const fetchLB = (w) => {
    setLoading(true)
    const url = w ? `${BACKEND}/leaderboard?week=${w}` : `${BACKEND}/leaderboard`
    fetch(url).then(r => r.json()).then(d => {
      setData(d)
      setWeek(d.week)
      setLoading(false)
    }).catch(() => setLoading(false))
  }

  useEffect(() => { fetchLB() }, [])

  return (
    <div className="flex flex-col min-h-dvh no-select" style={{ background: '#F0F4F8' }}>
      {/* Header */}
      <div className="sticky top-0 z-10 px-4 pt-12 pb-4"
           style={{ background: 'linear-gradient(160deg, #0F2A3F 0%, #1A6B9A 100%)' }}>
        <div className="flex items-center gap-3 mb-2">
          <button onClick={() => navigate(-1)} className="text-white/60 text-2xl leading-none">‹</button>
          <h1 className="text-white font-bold text-xl flex-1">🏆 每週排行榜</h1>
        </div>
        {/* Week selector */}
        {data?.availableWeeks?.length > 1 && (
          <div className="flex gap-2 mt-1 overflow-x-auto pb-1">
            {data.availableWeeks.map(w => (
              <button key={w} onClick={() => fetchLB(w)}
                      className={`text-xs px-3 py-1.5 rounded-lg shrink-0 ${
                        w === week ? 'bg-white text-medical-blue font-bold' : 'bg-white/15 text-white/60'
                      }`}>
                {w}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* List */}
      <div className="flex-1 px-4 py-4 flex flex-col gap-2.5">
        {loading && (
          <div className="flex items-center justify-center py-20">
            <span className="text-4xl animate-bounce">⚕️</span>
          </div>
        )}

        {!loading && (!data?.players || data.players.length === 0) && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <span className="text-5xl">🏜️</span>
            <p className="text-gray-400 text-sm">本週還沒有紀錄</p>
            <p className="text-gray-300 text-xs">練習或對戰後成績會自動上榜</p>
          </div>
        )}

        {!loading && data?.players?.map((p, i) => (
          <div key={p.name}
               className={`flex items-center gap-3 px-4 py-3.5 rounded-2xl shadow-sm border ${
                 i === 0 ? 'bg-amber-50 border-amber-200' :
                 i === 1 ? 'bg-gray-50 border-gray-200' :
                 i === 2 ? 'bg-orange-50 border-orange-200' :
                 'bg-white border-gray-100'
               }`}>
            <span className="text-2xl w-8 text-center shrink-0">
              {MEDALS[i] || <span className="text-sm font-bold text-gray-400">{i + 1}</span>}
            </span>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-gray-800 text-sm truncate">{p.name}</p>
              <p className="text-xs text-gray-400">{p.played} 場 · 正確率 {p.pct}%</p>
            </div>
            <div className="text-right shrink-0">
              <p className="font-bold text-lg text-gray-800">{p.score}</p>
              <p className="text-[10px] text-gray-400">{p.correct}/{p.total}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
