import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useExplain } from '../hooks/useAI'
import { ExplainPanel } from '../components/AIPanel'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

const YEARS    = ['110', '111', '112', '113']
const SESSIONS = ['第一次', '第二次']
const STAGE_COLORS = {
  anatomy:      '#3B82F6', physiology:  '#EF4444', biochemistry: '#8B5CF6',
  histology:    '#6366F1', microbiology:'#10B981', parasitology: '#D97706',
  pharmacology: '#F97316', pathology:   '#DC2626', public_health:'#0D9488',
  unknown:      '#94A3B8',
}
const OPTION_COLORS = { A: '#3B82F6', B: '#10B981', C: '#F97316', D: '#EF4444' }

/* ── Filter chip ─────────────────────────────────────────────── */
function Chip({ label, active, color, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 px-3.5 py-1.5 rounded-full text-sm font-medium transition-all active:scale-95 border
        ${active ? 'text-white border-transparent shadow-sm' : 'bg-white text-gray-500 border-gray-200'}`}
      style={active ? { background: color || '#1A6B9A' } : {}}
    >
      {label}
    </button>
  )
}

/* ── Question card ───────────────────────────────────────────── */
function QuestionCard({ q }) {
  const [open, setOpen] = useState(false)
  const [explainReq, setExplainReq] = useState(false)
  const tagColor = STAGE_COLORS[q.subject_tag] || '#94A3B8'
  const { text: explainText, loading: explainLoading, explain } = useExplain()

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      {/* Header row */}
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <span className="text-xs font-semibold text-white px-2 py-0.5 rounded-full"
              style={{ background: tagColor }}>
          {q.subject_name}
        </span>
        <span className="text-xs text-gray-400">{q.roc_year}年{q.session}</span>
        <span className="text-xs text-gray-300 ml-auto">#{q.number}</span>
      </div>

      {/* Question text */}
      <div className="px-4 pb-3">
        <p className="text-sm text-gray-800 leading-relaxed">{q.question}</p>
      </div>

      {/* Toggle options */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-2.5 border-t border-gray-100 text-xs text-gray-400 active:bg-gray-50 transition-colors"
      >
        <span>{open ? '收起選項' : '查看選項與答案'}</span>
        <span className={`transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>

      {/* Options + answer */}
      {open && (
        <div className="px-4 pb-4 flex flex-col gap-1.5 border-t border-gray-50">
          {Object.entries(q.options).map(([letter, text]) => {
            const isAnswer = q.answer === letter
            return (
              <div key={letter}
                   className={`flex items-start gap-2.5 px-3 py-2.5 rounded-xl text-sm
                     ${isAnswer ? 'text-white font-medium' : 'bg-gray-50 text-gray-600'}`}
                   style={isAnswer ? { background: tagColor } : {}}>
                <span className="font-bold shrink-0 w-4">{letter}</span>
                <span className="leading-snug">{text}</span>
                {isAnswer && <span className="ml-auto shrink-0">✓</span>}
              </div>
            )
          })}
          <div className="mt-2">
            <ExplainPanel
              text={explainText}
              loading={explainLoading}
              requested={explainReq}
              onRequest={() => { setExplainReq(true); explain(q) }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Main page ───────────────────────────────────────────────── */
export default function Browse() {
  const navigate = useNavigate()

  const [meta, setMeta]           = useState(null)
  const [questions, setQuestions] = useState([])
  const [total, setTotal]         = useState(0)
  const [page, setPage]           = useState(1)
  const [loading, setLoading]     = useState(false)
  const [hasMore, setHasMore]     = useState(true)

  // Filters
  const [year, setYear]         = useState('')
  const [session, setSession]   = useState('')
  const [stageTag, setStageTag] = useState('')
  const [query, setQuery]       = useState('')
  const [searchInput, setSearchInput] = useState('')

  const loaderRef = useRef(null)
  const LIMIT = 15

  // Load meta on mount
  useEffect(() => {
    fetch(`${BACKEND}/meta`).then(r => r.json()).then(setMeta).catch(() => {})
  }, [])

  // Fetch questions whenever filters change
  const fetchQuestions = useCallback(async (reset = false) => {
    setLoading(true)
    const p = reset ? 1 : page
    const params = new URLSearchParams({ page: p, limit: LIMIT })
    if (year)     params.set('year', year)
    if (session)  params.set('session', session)
    if (stageTag) params.set('subject_tag', stageTag)
    if (query)    params.set('q', query)

    try {
      const r = await fetch(`${BACKEND}/questions?${params}`)
      const data = await r.json()
      setTotal(data.total)
      setQuestions(prev => reset ? data.questions : [...prev, ...data.questions])
      setHasMore(data.questions.length === LIMIT)
      if (!reset) setPage(p + 1)
    } catch {}
    setLoading(false)
  }, [year, session, stageTag, query, page])

  // Reset on filter change
  useEffect(() => {
    setPage(1)
    setQuestions([])
    setHasMore(true)
    fetchQuestions(true)
  }, [year, session, stageTag, query])

  // Infinite scroll
  useEffect(() => {
    const el = loaderRef.current
    if (!el) return
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore && !loading) {
        setPage(p => p + 1)
      }
    }, { threshold: 0.1 })
    obs.observe(el)
    return () => obs.disconnect()
  }, [hasMore, loading])

  // Load next page when page increments (not on reset)
  const isFirstRender = useRef(true)
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return }
    if (page > 1) fetchQuestions(false)
  }, [page])

  const clearFilters = () => {
    setYear(''); setSession(''); setStageTag(''); setQuery(''); setSearchInput('')
  }
  const hasFilters = year || session || stageTag || query

  return (
    <div className="flex flex-col min-h-dvh no-select" style={{ background: '#F0F4F8' }}>

      {/* ── Header ───────────────────────────────────────────── */}
      <div className="sticky top-0 z-10"
           style={{ background: 'linear-gradient(160deg, #0F2A3F 0%, #1A6B9A 100%)' }}>
        <div className="px-4 pt-12 pb-3">
          <div className="flex items-center gap-3 mb-3">
            <button onClick={() => navigate('/')} className="text-white/60 text-2xl leading-none">‹</button>
            <h1 className="text-white font-bold text-xl flex-1">題庫瀏覽</h1>
            <span className="text-white/50 text-sm">{total} 題</span>
            {hasFilters && (
              <button onClick={clearFilters} className="text-xs text-white/60 border border-white/20 px-2.5 py-1 rounded-full">
                清除
              </button>
            )}
          </div>

          {/* Search bar */}
          <div className="relative mb-3">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
            <input
              className="w-full bg-white/15 border border-white/20 text-white placeholder-white/40 rounded-xl pl-9 pr-4 py-2.5 text-sm outline-none focus:bg-white/25"
              placeholder="搜尋題目內容..."
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && setQuery(searchInput)}
            />
            {searchInput && (
              <button
                onClick={() => { setSearchInput(''); setQuery('') }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/50 text-lg leading-none"
              >×</button>
            )}
          </div>
        </div>

        {/* Filter chips scrollable row */}
        <div className="overflow-x-auto scrollbar-none">
          <div className="flex gap-2 px-4 pb-3 w-max">

            {/* Year */}
            <Chip label="全部年份" active={!year} color="#1A6B9A"
                  onClick={() => setYear('')} />
            {YEARS.map(y => (
              <Chip key={y} label={`${y}年`} active={year === y} color="#1A6B9A"
                    onClick={() => setYear(year === y ? '' : y)} />
            ))}

            <div className="w-px bg-white/20 self-stretch mx-1" />

            {/* Session */}
            {SESSIONS.map(s => (
              <Chip key={s} label={s} active={session === s} color="#0D9488"
                    onClick={() => setSession(session === s ? '' : s)} />
            ))}

            <div className="w-px bg-white/20 self-stretch mx-1" />

            {/* Subject / Stage */}
            <Chip label="全部科目" active={!stageTag} color="#8B5CF6"
                  onClick={() => setStageTag('')} />
            {meta?.stages?.filter(s => s.tag !== 'unknown' && s.count > 0).map(s => (
              <Chip key={s.tag} label={s.name} active={stageTag === s.tag}
                    color={STAGE_COLORS[s.tag]}
                    onClick={() => setStageTag(stageTag === s.tag ? '' : s.tag)} />
            ))}
          </div>
        </div>
      </div>

      {/* ── Question list ─────────────────────────────────────── */}
      <div className="flex-1 px-4 py-4 flex flex-col gap-3">
        {questions.length === 0 && !loading && (
          <div className="flex-1 flex flex-col items-center justify-center py-20 gap-3">
            <span className="text-5xl">🔬</span>
            <p className="text-gray-400 text-sm">沒有符合條件的題目</p>
          </div>
        )}

        {questions.map(q => (
          <QuestionCard key={q.id} q={q} />
        ))}

        {/* Infinite scroll trigger */}
        <div ref={loaderRef} className="h-8 flex items-center justify-center">
          {loading && (
            <div className="flex gap-1.5">
              {[0,1,2].map(i => (
                <div key={i} className="w-2 h-2 rounded-full bg-medical-blue animate-bounce"
                     style={{ animationDelay: `${i*0.12}s` }} />
              ))}
            </div>
          )}
          {!hasMore && questions.length > 0 && (
            <p className="text-xs text-gray-300">— 已顯示全部 {total} 題 —</p>
          )}
        </div>
      </div>
    </div>
  )
}
