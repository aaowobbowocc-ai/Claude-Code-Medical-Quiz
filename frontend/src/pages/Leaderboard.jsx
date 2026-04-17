import React, { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { getLevelTitle, usePlayerStore } from '../store/gameStore'
import { usePageMeta } from '../hooks/usePageMeta'
import { getExamConfig, getCategoryMeta } from '../config/examRegistry'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const MEDALS = ['🥇', '🥈', '🥉']

// Colour/icon per category — matches persona cards on Home Stage 1
const CATEGORY_BADGE = {
  medical:           { icon: '🩺', label: '醫護', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  'law-professional':{ icon: '🛡️', label: '法律', color: 'bg-sky-50 text-sky-700 border-sky-200' },
  'civil-service':   { icon: '🏛️', label: '公職', color: 'bg-violet-50 text-violet-700 border-violet-200' },
  'common-subjects': { icon: '📚', label: '共同', color: 'bg-amber-50 text-amber-700 border-amber-200' },
}

const CATEGORY_FILTERS = [
  { id: 'medical',          label: '醫事'   },
  { id: 'law-professional', label: '法律'   },
  { id: 'civil-service',    label: '公職'   },
]

// Achievement badges awarded via crowdsourced maintenance / exam pioneering.
// legal_guardian is the only one wired this phase; the others are reserved.
const ACHIEVEMENT_BADGES = {
  legal_guardian:  { icon: '🛡️', title: '法律衛道人士', suffix: '已修正 {n} 題過時法條' },
  exam_pioneer:    { icon: '⭐',  title: '考試拓荒者',   suffix: '前 {n} 名首批挑戰者'   },
  disputed_hunter: { icon: '🎯',  title: '爭議題獵人',   suffix: '回報 {n} 題爭議題被採納' },
}

export default function Leaderboard() {
  const navigate = useNavigate()
  usePageMeta('排行榜', '國考知識王每週排行榜，看看誰是最強國考挑戰者！')
  const [data, setData] = useState(null)
  const [week, setWeek] = useState('')
  const [loading, setLoading] = useState(true)

  // Default category filter = the category of the user's current exam.
  const currentExam = usePlayerStore(s => s.exam) || 'doctor1'
  const defaultCategory = useMemo(() => {
    const cfg = getExamConfig(currentExam)
    return cfg?.category || 'medical'
  }, [currentExam])
  const [category, setCategory] = useState(defaultCategory)

  const fetchLB = (w, cat) => {
    setLoading(true)
    const params = new URLSearchParams()
    if (w) params.set('week', w)
    if (cat) params.set('category', cat)
    const qs = params.toString()
    const url = qs ? `${BACKEND}/leaderboard?${qs}` : `${BACKEND}/leaderboard`
    fetch(url).then(r => r.json()).then(d => {
      setData(d)
      setWeek(d.week)
      setLoading(false)
    }).catch(() => setLoading(false))
  }

  useEffect(() => { fetchLB(null, category) }, [category])

  // When the user-selected category's cohort is entirely quota-based, swap the
  // main score column from raw points to PR percentile — name-by-level exams
  // care about rank-in-cohort, not absolute points.
  const players = data?.players || []
  const showPR = category === 'civil-service' || category === 'law-professional'

  return (
    <div className="flex flex-col min-h-dvh no-select bg-medical-ice">
      {/* Header */}
      <div className="sticky top-0 z-10 px-4 pt-12 pb-4 grad-header">
        <div className="flex items-center gap-3 mb-2">
          <button onClick={() => navigate(-1)} className="text-white/60 text-2xl leading-none">‹</button>
          <h1 className="text-white font-bold text-xl flex-1">🏆 每週排行榜</h1>
        </div>

        {/* Category filter chips */}
        <div className="flex gap-2 mt-1 overflow-x-auto pb-1 -mx-1 px-1">
          {CATEGORY_FILTERS.map(f => {
            const active = f.id === category
            const count = data?.categoryCounts?.[f.id]
            return (
              <button key={f.id} onClick={() => setCategory(f.id)}
                      className={`text-xs px-3 py-1.5 rounded-lg shrink-0 font-semibold transition-colors ${
                        active ? 'bg-white text-medical-blue' : 'bg-white/15 text-white/70'
                      }`}>
                {f.label}{typeof count === 'number' && count > 0 ? ` · ${count}` : ''}
              </button>
            )
          })}
        </div>

        {/* Week selector */}
        {data?.availableWeeks?.length > 1 && (
          <div className="flex gap-2 mt-2 overflow-x-auto pb-1 -mx-1 px-1">
            {data.availableWeeks.map(w => (
              <button key={w} onClick={() => fetchLB(w, category)}
                      className={`text-[10px] px-2.5 py-1 rounded-md shrink-0 ${
                        w === week ? 'bg-white text-medical-blue font-bold' : 'bg-white/10 text-white/50'
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

        {!loading && players.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <span className="text-5xl">🏜️</span>
            <p className="text-gray-400 text-sm">
              此分類本週還沒有紀錄
            </p>
            <p className="text-gray-300 text-xs">練習或對戰後成績會自動上榜</p>
          </div>
        )}

        {!loading && players.map((p, i) => {
          const badge = p.category ? CATEGORY_BADGE[p.category] : null
          const examCfg = p.examId ? getExamConfig(p.examId) : null
          const examShort = examCfg?.short || null
          // PR mode: display PR percentile as the primary metric; raw score → sub-line.
          // Score mode: display score as primary; correct/total → sub-line.
          const quotaRow = showPR && (p.selectionType === 'quota' || !p.selectionType)
          return (
            <div key={`${p.name}-${p.examId || ''}`}
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
                <div className="flex items-center gap-1.5 flex-wrap">
                  {badge && (
                    <span className={`text-[9px] px-1.5 py-0.5 rounded border font-semibold ${badge.color}`}>
                      {badge.icon}{examShort || badge.label}
                    </span>
                  )}
                  <p className="font-bold text-gray-800 text-sm truncate">{p.name}</p>
                  {p.achievements && Object.entries(p.achievements).map(([aid, cnt]) => {
                    const def = ACHIEVEMENT_BADGES[aid]
                    if (!def || !cnt) return null
                    return (
                      <span key={aid}
                            title={`${def.title}・${def.suffix.replace('{n}', cnt)}`}
                            className="text-sm leading-none">
                        {def.icon}
                      </span>
                    )
                  })}
                </div>
                <p className="text-xs text-gray-400 mt-0.5">
                  {p.level ? `${getLevelTitle(p.level).icon} ${getLevelTitle(p.level).title} · ` : ''}{p.played} 場 · 正確率 {p.pct}%
                </p>
              </div>
              <div className="text-right shrink-0">
                {quotaRow ? (
                  <>
                    <p className="font-bold text-lg text-gray-800">PR {p.pr}</p>
                    <p className="text-[10px] text-gray-400">{p.score} 分</p>
                  </>
                ) : (
                  <>
                    <p className="font-bold text-lg text-gray-800">{p.score}</p>
                    <p className="text-[10px] text-gray-400">{p.correct}/{p.total}</p>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
