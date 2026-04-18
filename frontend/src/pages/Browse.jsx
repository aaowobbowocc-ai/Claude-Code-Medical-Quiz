import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/gameStore'
import { useExplain } from '../hooks/useAI'
import { ExplainPanel } from '../components/AIPanel'
import QuestionImages from '../components/QuestionImages'
import CommentSection from '../components/CommentSection'
import { useBookmarks } from '../hooks/useBookmarks'
import { usePageMeta } from '../hooks/usePageMeta'
import ReadingModePopover, { useReadingMode } from '../components/ReadingModePopover'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

// Dynamic exam list built from /meta data — no longer hardcoded
import { getStageStyle as _getStageStyle, getExamConfig } from '../config/examRegistry'
const _paperColors = { paper1: '#3B82F6', paper2: '#10B981', paper3: '#8B5CF6', paper4: '#F97316', paper5: '#EF4444', paper6: '#0D9488' }
function getStageColor(tag) {
  return _getStageStyle(tag)?.color || _paperColors[tag] || '#94A3B8'
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
function QuestionCard({ q, stageMap, readingStyle, readingPrefs, updateReadingPrefs, isLegal, isLongText }) {
  const [open, setOpen] = useState(false)
  const [explainReq, setExplainReq] = useState(false)
  const [classifying, setClassifying] = useState(false)
  const [localTag, setLocalTag] = useState(q.subject_tag || '')
  const [showFolderPick, setShowFolderPick] = useState(false)
  const [questionCollapsed, setQuestionCollapsed] = useState(!!isLongText)
  const { isBookmarked, getFolder, folders, addToFolder, removeBookmark, getFolderQuestions, MAX_PER_FOLDER } = useBookmarks()
  const bookmarked = isBookmarked(q)
  const currentFolder = getFolder(q)
  const examType = usePlayerStore(s => s.exam) || 'doctor1'
  const tagColor = getStageColor(localTag)
  const stageMeta = stageMap?.[localTag]
  const tagName  = !localTag || localTag === 'unknown'
    ? (q.subject_name || q.subject || '未分類')
    : (stageMeta?.name || q.subject_name || SUBJECTS.find(s => s.tag === localTag)?.name || q.subject || '未分類')
  const { text: explainText, loading: explainLoading, limitHit: explainLimitHit, notEnoughCoins: explainNoCoins, explain, remaining: explainRemaining, cost: explainCost, meta: explainMeta, vote: explainVote } = useExplain()

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
        {q.roc_year && <span className="text-xs text-gray-400">{q.roc_year}年{q.session}</span>}
        {q.isSharedBank && (
          <span
            className="text-[10px] font-semibold text-sky-700 bg-sky-50 border border-sky-200 px-1.5 py-0.5 rounded-full"
            title={q.sourceLabel || '同等推薦'}
          >
            同等推薦
          </span>
        )}
        {localTag === 'unknown' && (usePlayerStore.getState().exam || 'doctor1') === 'doctor1' && (
          <button
            onClick={() => setClassifying(true)}
            className="text-xs text-amber-500 border border-amber-300 px-2 py-0.5 rounded-full bg-amber-50 active:scale-95 transition-transform"
          >
            🏷️ 幫忙分類
          </button>
        )}
        <div className="flex items-center gap-1.5 ml-auto">
          <ReadingModePopover examId={examType} prominent={isLegal} prefs={readingPrefs} onUpdate={updateReadingPrefs} />
          <button onClick={(e) => { e.stopPropagation(); bookmarked ? removeBookmark(q) : setShowFolderPick(!showFolderPick) }}
            className="text-base active:scale-90 transition-transform" title={bookmarked ? `已收藏（${currentFolder}）` : '收藏題目'}>
            {bookmarked ? '⭐' : '☆'}
          </button>
          <span className="text-xs font-mono font-semibold text-gray-500 bg-gray-100 px-2 py-0.5 rounded-lg">
            #{q.number}
          </span>
        </div>
      </div>

      {showFolderPick && (
        <div className="px-4 pb-2 flex gap-2">
          {folders.map(f => {
            const count = getFolderQuestions(f).length
            const full = count >= MAX_PER_FOLDER
            return (
              <button key={f} onClick={() => { if (!full) { addToFolder(q, f); setShowFolderPick(false) } }}
                disabled={full}
                className={`flex-1 text-xs font-bold py-2 rounded-xl border active:scale-95 transition-all ${full ? 'bg-gray-50 text-gray-300 border-gray-100' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                ⭐ {f} ({count}/{MAX_PER_FOLDER})
              </button>
            )
          })}
        </div>
      )}

      {classifying && (
        <ClassifySheet q={q} onClose={(tag) => handleVoteDone(tag)} />
      )}

      {/* Case context (grouped questions) */}
      {q.case_context && (
        <div className="mx-4 mb-2 bg-amber-50 border border-amber-200 rounded-xl p-3">
          <span className="text-[10px] font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full mb-1.5 inline-block">案例</span>
          <p className="text-sm text-gray-700" style={readingStyle}>{q.case_context}</p>
          {q.groupInfo && (
            <p className="text-[10px] text-amber-600 mt-1.5">題組：第 {q.groupInfo.currentInGroup}/{q.groupInfo.totalInGroup} 題</p>
          )}
        </div>
      )}

      {/* Question text */}
      <div className="px-4 pb-3">
        {q.is_deprecated && (
          <div className="mb-2 bg-red-50 border-l-4 border-red-400 rounded-r-xl px-3 py-2">
            <p className="text-xs font-bold text-red-600">⚠️ 此題對應條文已修正</p>
            {q.deprecated_reason && (
              <p className="text-xs text-red-500 mt-0.5 leading-relaxed">{q.deprecated_reason}</p>
            )}
            <p className="text-[11px] text-red-400 mt-1">原答案僅供歷史參考,本題不計入弱點與任務進度</p>
          </div>
        )}
        {isLongText ? (
          <div>
            <p className={`text-sm text-gray-800 ${questionCollapsed ? 'line-clamp-2' : ''}`} style={readingStyle}>{q.question}</p>
            <button type="button" onClick={() => setQuestionCollapsed(c => !c)}
              className="text-[11px] text-medical-blue font-semibold mt-1 active:opacity-70">
              {questionCollapsed ? '展開全文 ▾' : '收合 ▴'}
            </button>
          </div>
        ) : (
          <p className="text-sm text-gray-800" style={readingStyle}>{q.question}</p>
        )}
        <QuestionImages images={q.images} imageUrl={q.image_url} incomplete={q.incomplete} />
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
          {q.answer === '送分' && (
            <div className="px-3 py-2 rounded-xl text-sm bg-amber-50 text-amber-700 font-medium">
              ⚠️ 本題一律給分（試題疑義後送分）
            </div>
          )}
          {q.answer_corrected && q.answer !== '送分' && (
            <div className="px-3 py-2 rounded-xl text-sm bg-blue-50 text-blue-700 font-medium">
              📝 答案已更正：{q.answer.replace(',', ' 或 ')} 均給分{q.original_answer ? `（原答案：${q.original_answer}）` : ''}
            </div>
          )}
          {Object.entries(q.options).map(([letter, text]) => {
            const isVoided = q.answer === '送分'
            const isAnswer = isVoided ? false : (q.answer?.includes(',') ? q.answer.split(',').includes(letter) : q.answer === letter)
            return (
              <div key={letter}
                   className={`flex items-start gap-2.5 px-3 py-2.5 rounded-xl text-sm
                     ${isAnswer ? 'text-white font-medium' : isVoided ? 'bg-green-50 text-gray-600' : 'bg-gray-50 text-gray-600'}`}
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
              notEnoughCoins={explainNoCoins}
              remaining={explainRemaining}
              cost={explainCost}
              requested={explainReq}
              onRequest={() => { setExplainReq(true); explain(q) }}
              answer={q.answer}
              options={q.options}
              explanation={q.explanation}
              questionId={q.id}
              questionText={q.question}
              rocYear={q.roc_year}
              session={q.session}
              number={q.number}
              disputed={q.disputed}
              subjectTags={q.subject_tags}
              sourceBankId={q.sourceBankId}
              meta={explainMeta}
              onVote={explainVote}
            />
            {q.id && <CommentSection targetId={`q_${q.id}`} />}
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

  // Build tag→name map from meta stages
  const stageMap = React.useMemo(() => {
    if (!meta?.stages) return {}
    return Object.fromEntries(meta.stages.map(s => [s.tag, s]))
  }, [meta])

  // Load meta (reactive to exam type)
  const examType = usePlayerStore(s => s.exam) || 'doctor1'
  const examCfg = getExamConfig(examType)
  const examName = examCfg?.name || '國考'
  const isLegalExam = examCfg?.category === 'law-professional' || examCfg?.category === 'civil-service'
  const isLongTextExam = !!examCfg?.uxHints?.longText
  const { prefs: readingPrefs, update: updateReadingPrefs, style: readingStyle } = useReadingMode(examType, isLegalExam)
  usePageMeta(
    `${examName} 題庫瀏覽`,
    `${examName}歷屆考古題線上題庫，按科目年度自由瀏覽，支援搜尋、AI 解說與收藏，歷年國考完整收錄。`,
    { canonical: `https://examking.tw/browse?exam=${examType}` }
  )
  const prevExamRef = useRef(examType)
  useEffect(() => {
    const changed = prevExamRef.current !== examType
    prevExamRef.current = examType
    if (changed) {
      setExam(null); setStageTag(''); setQuery(''); setSearchInput('')
    }
    setMeta(null)
    fetch(`${BACKEND}/meta?exam=${examType}`).then(r => r.json()).then(setMeta).catch(() => {})
  }, [examType])

  // Fetch questions
  const fetchQuestions = useCallback(async (reset = false) => {
    setLoading(true)
    const p = reset ? 1 : page
    const currentExam = usePlayerStore.getState().exam || 'doctor1'
    const params = new URLSearchParams({ page: p, limit: LIMIT, exam: currentExam })
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
  }, [exam, stageTag, query, examType])

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

        {/* Filter dropdowns */}
        <div className="flex gap-2 px-4 pb-3">
          <select
            value={exam?.label || ''}
            onChange={e => setExam((meta?.exams || []).find(ex => ex.label === e.target.value) || null)}
            className="flex-1 min-w-0 bg-white/95 text-gray-700 rounded-xl px-3 py-2 text-sm border-0 outline-none"
            style={{ colorScheme: 'light' }}
          >
            <option value="">全部年份</option>
            {(meta?.exams || []).map(e => (
              <option key={e.label} value={e.label}>{e.label}</option>
            ))}
          </select>

          {meta?.stages?.some(s => s.tag !== 'all' && s.tag !== 'unknown' && (s.count > 0 || s.count === undefined)) && (
            <select
              value={stageTag}
              onChange={e => setStageTag(e.target.value)}
              className="flex-1 min-w-0 bg-white/95 text-gray-700 rounded-xl px-3 py-2 text-sm border-0 outline-none"
              style={{ colorScheme: 'light' }}
            >
              <option value="">全部科目</option>
              {meta.stages.filter(s => s.tag !== 'all' && s.tag !== 'unknown').map(s => (
                <option key={s.tag} value={s.tag}>{s.name}</option>
              ))}
            </select>
          )}
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
          <QuestionCard key={q.id} q={q} stageMap={stageMap}
            readingStyle={readingStyle} readingPrefs={readingPrefs}
            updateReadingPrefs={updateReadingPrefs} isLegal={isLegalExam}
            isLongText={isLongTextExam} />
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
