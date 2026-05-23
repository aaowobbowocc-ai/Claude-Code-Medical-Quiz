import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { getRegistry } from '../config/examRegistry'
import Footer from '../components/Footer'
import { formatYearSession } from '../utils/sessionLabel'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

/**
 * 全題庫搜尋 — Vertex AI Search 後端，跨 52 個考試 / 216k 題。
 *
 * - 輸入框 debounce 350ms 後送 query
 * - 可選 examFilter（單一考試）/ yearFilter（民國年）
 * - 每筆結果顯示：考試 / 年度 / 科目 / 題號 / snippet（命中片段）
 * - 點 hit 展開：全文題幹 + 4 選項 + 正確答案
 * - 「去這個考試」按鈕：deep-link 切到該考試的 Home
 */
export default function Search() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [examFilter, setExamFilter] = useState('')
  const [yearFilter, setYearFilter] = useState('')
  const [hits, setHits] = useState([])
  const [totalSize, setTotalSize] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState(new Set())
  const reqIdRef = useRef(0)
  const inputRef = useRef(null)

  // Build exam list from registry for filter dropdown.
  const examOptions = useMemo(() => {
    try {
      const r = getRegistry() || {}
      // Registry is { exams: { id: {...}, ... }, ... } — keys vary by load timing,
      // fall through gracefully if not ready.
      const entries = Object.entries(r.exams || r)
      return entries
        .map(([id, cfg]) => ({ id, name: cfg?.name || id }))
        .filter(e => e.name && e.id && !e.id.startsWith('_'))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
    } catch {
      return []
    }
  }, [])

  // Debounce input. Min length 2 — 1 char is too noisy across a 216k corpus.
  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setDebounced('')
      return
    }
    const t = setTimeout(() => setDebounced(trimmed), 350)
    return () => clearTimeout(t)
  }, [query])

  // Fire search whenever debounced query or filters change.
  useEffect(() => {
    if (!debounced) {
      setHits([])
      setTotalSize(0)
      setError(null)
      setLoading(false)
      return
    }
    const myReqId = ++reqIdRef.current
    setLoading(true)
    setError(null)
    setExpanded(new Set())
    ;(async () => {
      try {
        const r = await fetch(`${BACKEND}/search/questions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            q: debounced,
            limit: 30,
            examFilter: examFilter || undefined,
            yearFilter: yearFilter || undefined,
          }),
        })
        const data = await r.json()
        // Ignore stale responses (user typed more during the request)
        if (myReqId !== reqIdRef.current) return
        if (!r.ok) {
          setError(data?.error === 'search_not_configured'
            ? '搜尋功能還沒上線（後端尚未配置）'
            : data?.detail || data?.error || '搜尋失敗')
          setHits([])
          setTotalSize(0)
        } else {
          setHits(data.hits || [])
          setTotalSize(data.totalSize || 0)
        }
      } catch (e) {
        if (myReqId !== reqIdRef.current) return
        setError('連線失敗：' + e.message)
        setHits([])
      } finally {
        if (myReqId === reqIdRef.current) setLoading(false)
      }
    })()
  }, [debounced, examFilter, yearFilter])

  // Auto-focus input on mount for instant typing
  useEffect(() => { inputRef.current?.focus() }, [])

  const toggleExpand = (id) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const jumpToExam = (examId) => {
    navigate(`/${examId}/`)
  }

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      {/* Header */}
      <div className="grad-header text-white px-4 pt-5 pb-4">
        <button onClick={() => navigate(-1)}
                className="text-white/80 text-sm mb-2 active:opacity-70">‹ 返回</button>
        <h1 className="text-xl font-bold">🔍 全題庫搜尋</h1>
        <p className="text-white/80 text-xs mt-0.5">
          跨 52 個考試 / 216,685 題 — 關鍵字 / 藥名 / 條文 / 病症都可以
        </p>
      </div>

      {/* Search controls */}
      <div className="px-4 pt-4 pb-2 space-y-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="例如：fomepizole、急性心肌梗塞、民法 184"
          className="w-full px-4 py-3 rounded-2xl border border-gray-200 bg-white shadow-sm focus:border-medical-blue focus:outline-none text-sm"
        />
        <div className="flex gap-2">
          <select value={examFilter} onChange={e => setExamFilter(e.target.value)}
                  className="flex-1 px-3 py-2 rounded-xl border border-gray-200 bg-white text-xs">
            <option value="">所有考試</option>
            {examOptions.map(e => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
          <select value={yearFilter} onChange={e => setYearFilter(e.target.value)}
                  className="w-28 px-3 py-2 rounded-xl border border-gray-200 bg-white text-xs">
            <option value="">所有年度</option>
            {Array.from({ length: 16 }, (_, i) => 100 + i).map(y => (
              <option key={y} value={y}>民國 {y}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Status line */}
      <div className="px-4 py-2 text-xs text-gray-500">
        {!debounced && query.trim().length === 0 && (
          <p>輸入 2 個字以上開始搜尋</p>
        )}
        {!debounced && query.trim().length === 1 && (
          <p>請再輸入一個字…</p>
        )}
        {loading && <p>搜尋中…</p>}
        {!loading && debounced && hits.length === 0 && !error && (
          <p>找不到符合「{debounced}」的題目</p>
        )}
        {!loading && debounced && hits.length > 0 && (
          <p>找到 {totalSize.toLocaleString()} 題，顯示前 {hits.length} 筆</p>
        )}
        {error && <p className="text-red-500">{error}</p>}
      </div>

      {/* Results */}
      <div className="px-4 pb-6 space-y-2 flex-1">
        {hits.map(h => {
          const isOpen = expanded.has(h.id)
          // Parse the stored content: first line is stem, rest are A./B./C./D.
          const lines = (h.content || '').split('\n').filter(Boolean)
          const stem = lines[0] || ''
          const opts = lines.slice(1)
          return (
            <div key={h.id}
                 className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              <button onClick={() => toggleExpand(h.id)}
                      className="w-full text-left px-4 py-3 active:bg-gray-50">
                <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                  <span className="text-[10px] font-bold text-white bg-medical-blue px-2 py-0.5 rounded-full">
                    {h.exam_name || h.exam_id}
                  </span>
                  <span className="text-[10px] text-gray-500">
                    {formatYearSession({ roc_year: h.roc_year, session: h.session })}
                  </span>
                  {h.subject_name && (
                    <span className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                      {h.subject_name}
                    </span>
                  )}
                  <span className="text-[10px] font-mono text-gray-400 ml-auto">
                    #{h.number}
                  </span>
                </div>
                <p className="text-sm text-gray-800 leading-relaxed line-clamp-2">
                  {isOpen ? stem : (h.snippet || stem)}
                </p>
                <p className="text-[10px] text-gray-400 mt-1">
                  {isOpen ? '收合 ▴' : '展開完整題目與答案 ▾'}
                </p>
              </button>

              {isOpen && (
                <div className="border-t border-gray-100 px-4 py-3 bg-gray-50/50">
                  {opts.length > 0 && (
                    <div className="space-y-1 mb-3">
                      {opts.map((opt, i) => {
                        const letter = opt.match(/^([A-D])\./)?.[1]
                        const isCorrect = letter && letter === h.answer
                        return (
                          <p key={i}
                             className={`text-sm leading-relaxed px-2 py-1 rounded ${
                               isCorrect ? 'bg-emerald-50 text-emerald-800 font-semibold' : 'text-gray-700'
                             }`}>
                            {opt}
                            {isCorrect && <span className="ml-1 text-[10px]">← 正解</span>}
                          </p>
                        )
                      })}
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-gray-500">正確答案：</span>
                    <span className="font-bold text-emerald-600">{h.answer || '?'}</span>
                    <button onClick={() => jumpToExam(h.exam_id)}
                            className="ml-auto px-3 py-1.5 rounded-lg bg-medical-blue text-white text-[11px] font-semibold active:scale-95">
                      去 {h.exam_name} 練習 →
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <Footer />
    </div>
  )
}
