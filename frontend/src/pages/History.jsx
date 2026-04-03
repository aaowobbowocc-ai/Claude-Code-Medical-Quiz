import React from 'react'
import { useNavigate } from 'react-router-dom'

const HISTORY_KEY = 'battle-history'

function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') } catch { return [] }
}

function formatDate(iso) {
  const d = new Date(iso)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function History() {
  const navigate = useNavigate()
  const records = getHistory()

  return (
    <div className="flex flex-col min-h-dvh no-select bg-medical-ice">
      {/* Header */}
      <div className="sticky top-0 z-10 px-4 pt-12 pb-4"
           style={{ background: 'linear-gradient(160deg, #0F2A3F 0%, #1A6B9A 100%)' }}>
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="text-white/60 text-2xl leading-none">‹</button>
          <h1 className="text-white font-bold text-xl flex-1">對戰紀錄</h1>
          <span className="text-white/50 text-sm">{records.length} 場</span>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 px-4 py-4 flex flex-col gap-3">
        {records.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <span className="text-5xl">🎮</span>
            <p className="text-gray-400 text-sm">還沒有對戰紀錄</p>
            <button onClick={() => navigate('/')}
                    className="mt-2 px-6 py-3 rounded-2xl font-bold text-white text-sm active:scale-95"
                    style={{ background: 'linear-gradient(135deg, #1A6B9A, #0D9488)' }}>
              去對戰
            </button>
          </div>
        )}

        {records.map(r => {
          const isWin  = r.rank === 1
          const pct    = r.totalCount > 0 ? Math.round((r.correctCount / r.totalCount) * 100) : 0
          const oppStr = r.opponents?.map(o => o.name).join('、') || '—'
          const wrongCount = r.totalCount - r.correctCount

          return (
            <div key={r.id} className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              {/* Top row */}
              <div className="flex items-center gap-3 px-4 pt-3 pb-2">
                <span className={`text-2xl`}>{isWin ? '🏆' : '💪'}</span>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full text-white ${isWin ? 'bg-amber-400' : 'bg-gray-400'}`}>
                      {isWin ? '勝利' : `第 ${r.rank} 名`}
                    </span>
                    <span className="text-xs text-gray-400">{r.stage}</span>
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">vs {oppStr} · {formatDate(r.date)}</p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-medical-dark text-lg leading-tight">{r.myScore}</p>
                  <p className="text-xs text-gray-400">分</p>
                </div>
              </div>

              {/* Stats row */}
              <div className="flex items-center gap-3 px-4 pb-3 border-t border-gray-50 pt-2">
                <div className="flex-1">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-gray-400">正確率</span>
                    <span className="font-semibold text-medical-dark">{r.correctCount}/{r.totalCount} ({pct}%)</span>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all"
                         style={{ width: `${pct}%`, background: pct >= 70 ? '#10B981' : pct >= 50 ? '#F97316' : '#EF4444' }} />
                  </div>
                </div>

                {/* Review button — only if has wrong answers */}
                {wrongCount > 0 && r.questions?.length > 0 && (
                  <button
                    onClick={() => navigate('/review', { state: { questions: r.questions, stage: r.stage } })}
                    className="shrink-0 text-xs font-bold px-3 py-2 rounded-xl text-white active:scale-95 transition-transform"
                    style={{ background: '#EF4444' }}>
                    📋 檢討 {wrongCount} 題
                  </button>
                )}
                {wrongCount === 0 && r.totalCount > 0 && (
                  <span className="text-xs text-green-500 font-semibold shrink-0">全對 🎉</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
