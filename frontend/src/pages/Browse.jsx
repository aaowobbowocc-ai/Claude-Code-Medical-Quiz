import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useExplain } from '../hooks/useAI'
import { ExplainPanel } from '../components/AIPanel'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

const EXAMS = [
  { label: '110年一', year: '110', session: '第一次' },
  { label: '110年二', year: '110', session: '第二次' },
  { label: '111年一', year: '111', session: '第一次' },
  { label: '111年二', year: '111', session: '第二次' },
  { label: '112年一', year: '112', session: '第一次' },
  { label: '112年二', year: '112', session: '第二次' },
  { label: '113年一', year: '113', session: '第一次' },
  { label: '113年二', year: '113', session: '第二次' },
  { label: '114年一', year: '114', session: '第一次' },
  { label: '114年二', year: '114', session: '第二次' },
  { label: '115年一', year: '115', session: '第一次' },
]
const STAGE_COLORS = {
  anatomy:      '#3B82F6', physiology:  '#EF4444', biochemistry: '#8B5CF6',
  histology:    '#6366F1', embryology:  '#818CF8', microbiology:'#10B981',
  parasitology: '#D97706', pharmacology: '#F97316', pathology:   '#DC2626',
  public_health:'#0D9488', unknown:      '#94A3B8',
}
const OPTION_COLORS = { A: '#3B82F6', B: '#10B981', C: '#F97316', D: '#EF4444' }

const SUBJECTS = [
  { tag: 'anatomy',      name: '解剖學',      color: '#3B82F6' },
  { tag: 'physiology',   name: '生理學',      color: '#EF4444' },
  { tag: 'biochemistry', name: '生物化學',    color: '#8B5CF6' },
  { tag: 'histology',    name: '組織學',      color: '#6366F1' },
  { tag: 'embryology',   name: '胚胎學',      color: '#818CF8' },
  { tag: 'microbiology', name: '微生物與免疫', color: '#10B981' },
  { tag: 'parasitology', name: '寄生蟲學',   color: '#D97706' },
  { tag: 'pharmacology', name: '藥理學',     color: '#F97316' },
  { tag: 'pathology',    name: '病理學',     color: '#DC2626' },
  { tag: 'public_health',name: '公共衛生',   color: '#0D9488' },
]

const VOTED_KEY = 'classified-votes'
function getVoted() { try { return JSON.parse(localStorage.getItem(VOTED_KEY) || '{}') } catch { return {} } }
function markVoted(id, tag) {
  const v = getVoted(); v[id] = tag; localStorage.setItem(VOTED_KEY, JSON.stringify(v))
}

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

/* ── Classify sheet ──────────────────────────────────────────── */
function ClassifySheet({ q, onClose }) {
  const voted = getVoted()[q.id]
  const [sent, setSent] = useState(voted || null)
  const [counts, setCounts] = useState({})

  const vote = async (tag) => {
    setSent(tag)
    markVoted(q.id, tag)
    try {
      const r = await fetch(`${BACKEND}/classify-vote`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: q.id, subjectTag: tag }),
      })
      const data = await r.json()
      setCounts(prev => ({ ...prev, [tag]: data.count }))
    } catch {}
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
         onClick={onClose}>
      <div className="w-full max-w-[430px] bg-white rounded-t-3xl px-5 pb-10 pt-2"
           onClick={e => e.stopPropagation()}>
        <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-5" />
        {sent ? (
          <div className="text-center py-6">
            <div className="text-5xl mb-3">🙌</div>
            <p className="font-bold text-medical-dark text-lg">感謝你的貢獻！</p>
            <p className="text-gray-400 text-sm mt-1.5 leading-relaxed">
              你認為這題屬於<span className="text-medical-blue font-semibold">「{SUBJECTS.find(s=>s.tag===sent)?.name}」</span>
              <br />累積 3 票即自動更新分類
            </p>
            <button onClick={() => onClose(sent)}
                    className="mt-6 px-8 py-3 rounded-2xl font-bold text-white active:scale-95 grad-cta">
              關閉
            </button>
          </div>
        ) : (
          <>
            <p className="font-bold text-medical-dark text-center mb-1">這題屬於哪個科目？</p>
            <p className="text-gray-400 text-xs text-center mb-5 leading-relaxed">
              你的判斷會幫助其他同學找到題目
            </p>
            <div className="grid grid-cols-3 gap-2">
              {SUBJECTS.map(s => (
                <button key={s.tag} onClick={() => vote(s.tag)}
                        className="py-3 rounded-2xl text-white text-sm font-semibold active:scale-95 transition-transform"
                        style={{ background: s.color }}>
                  {s.name}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ── Question card ───────────────────────────────────────────── */
function QuestionCard({ q }) {
  const [open, setOpen] = useState(false)
  const [explainReq, setExplainReq] = useState(false)
  const [classifying, setClassifying] = useState(false)
  const [localTag, setLocalTag] = useState(q.subject_tag)
  const tagColor = STAGE_COLORS[localTag] || '#94A3B8'
  const tagName  = localTag === 'unknown'
    ? '未分類' : (SUBJECTS.find(s => s.tag === localTag)?.name || q.subject_name)
  const { text: explainText, loading: explainLoading, limitHit: explainLimitHit, explain, remaining: explainRemaining } = useExplain()

  const handleVoteDone = (tag) => {
    if (tag) setLocalTag(tag)  // optimistic update if classified
    setClassifying(false)
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      {/* Header row */}
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <span className="text-xs font-semibold text-white px-2 py-0.5 rounded-full"
              style={{ background: tagColor }}>
          {tagName}
        </span>
        <span className="text-xs text-gray-400">{q.roc_year}年{q.session}</span>
        {localTag === 'unknown' && (
          <button
            onClick={() => setClassifying(true)}
            className="text-xs text-amber-500 border border-amber-300 px-2 py-0.5 rounded-full bg-amber-50 active:scale-95 transition-transform"
          >
            🏷️ 幫忙分類
          </button>
        )}
        <span className="text-xs font-mono font-semibold text-gray-500 bg-gray-100 px-2 py-0.5 rounded-lg ml-auto">
          #{q.number}
        </span>
      </div>

      {classifying && (
        <ClassifySheet q={q} onClose={(tag) => handleVoteDone(tag)} />
      )}

      {/* Question text */}
      <div className="px-4 pb-3">
        <p className="text-sm text-gray-800 leading-relaxed">{q.question}</p>
        {q.image_url && (
          <img src={q.image_url} alt="題目圖片"
               className="mt-3 w-full rounded-xl border border-gray-100 object-contain max-h-56" />
        )}
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
              limitHit={explainLimitHit}
              remaining={explainRemaining}
              requested={explainReq}
              onRequest={() => { setExplainReq(true); explain(q) }}
              answer={q.answer}
              options={q.options}
              explanation={q.explanation}
              questionId={q.id}
              questionText={q.question}
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

  // Filters — restore from sessionStorage
  const saved = useRef((() => { try { return JSON.parse(sessionStorage.getItem('browse-filters') || '{}') } catch { return {} } })())
  const [exam, setExam]         = useState(saved.current.exam || null)
  const [stageTag, setStageTag] = useState(saved.current.stageTag || '')
  const [query, setQuery]       = useState(saved.current.query || '')
  const [searchInput, setSearchInput] = useState(saved.current.query || '')

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
    if (exam?.year)    params.set('year', exam.year)
    if (exam?.session) params.set('session', exam.session)
    if (stageTag)      params.set('subject_tag', stageTag)
    if (query)         params.set('q', query)

    try {
      const r = await fetch(`${BACKEND}/questions?${params}`)
      const data = await r.json()
      setTotal(data.total)
      setQuestions(prev => reset ? data.questions : [...prev, ...data.questions])
      setHasMore(data.questions.length === LIMIT)
      if (!reset) setPage(p + 1)
    } catch {}
    setLoading(false)
  }, [exam, stageTag, query, page])

  // Reset on filter change + persist
  useEffect(() => {
    setPage(1)
    setQuestions([])
    setHasMore(true)
    fetchQuestions(true)
    try { sessionStorage.setItem('browse-filters', JSON.stringify({ exam, stageTag, query })) } catch {}
  }, [exam, stageTag, query])

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
    setExam(null); setStageTag(''); setQuery(''); setSearchInput('')
  }
  const hasFilters = exam || stageTag || query

  return (
    <div className="flex flex-col min-h-dvh no-select bg-medical-ice">

      {/* ── Header ───────────────────────────────────────────── */}
      <div className="sticky top-0 z-10 grad-header">
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

            {/* Exam (year + session combined) */}
            <Chip label="全部考試" active={!exam} color="#1A6B9A"
                  onClick={() => setExam(null)} />
            {EXAMS.map(e => (
              <Chip key={e.label} label={e.label} active={exam?.label === e.label} color="#1A6B9A"
                    onClick={() => setExam(exam?.label === e.label ? null : e)} />
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
