import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/gameStore'
import { useSound } from '../hooks/useSound'
import { useExplain, useReview } from '../hooks/useAI'
import { getSubjectColor } from '../utils/subjectColors'
import { ExplainPanel, ReviewPanel } from '../components/AIPanel'
import SmartBanner from '../components/SmartBanner'
import QuestionImages from '../components/QuestionImages'
import CommentSection from '../components/CommentSection'
import { useBookmarks } from '../hooks/useBookmarks'
import { useAccuracyStore } from '../store/accuracyStore'
import { usePageMeta } from '../hooks/usePageMeta'
import ShareChallengeButton from '../components/ShareChallengeButton'
import { supabase } from '../lib/supabase'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

import { getStageStyle as getStageStyleFromRegistry, getExamConfig } from '../config/examRegistry'

const SOURCE_MODE_KEY_PREFIX = 'practice-source-mode:'
function getSourceMode(examId) {
  try {
    const v = localStorage.getItem(SOURCE_MODE_KEY_PREFIX + examId)
    if (v === 'pure' || v === 'reservoir') return v
  } catch {}
  const cfg = getExamConfig(examId)
  return cfg?.uxHints?.defaultMode === 'reservoir' ? 'reservoir' : 'pure'
}
function saveSourceMode(examId, mode) {
  try { localStorage.setItem(SOURCE_MODE_KEY_PREFIX + examId, mode) } catch {}
}
function examHasSharedBanks(examId) {
  const cfg = getExamConfig(examId)
  return Array.isArray(cfg?.sharedBanks) && cfg.sharedBanks.length > 0
}

const FALLBACK_COLORS = ['#3B82F6', '#EF4444', '#10B981', '#F97316', '#8B5CF6', '#D97706', '#6366F1', '#0D9488', '#DC2626', '#EC4899']

function formatStages(raw) {
  if (!raw || !raw.length) return [{ id: 0, name: '全部題目', icon: '🎲', color: '#64748B' }]
  return raw.map((s, i) => {
    const style = getStageStyleFromRegistry(s.tag) || { icon: '📝', color: FALLBACK_COLORS[i % FALLBACK_COLORS.length] }
    return { id: s.id, name: s.name, icon: style.icon, color: style.color, count: s.count }
  })
}

const DIFFICULTIES = [
  { id: 'easy',   label: '初級',   icon: '🌱', desc: '30秒作答・無AI對手',   time: 30, ai: false },
  { id: 'medium', label: '普通',   icon: '⚡', desc: '15秒作答・AI對手',     time: 15, ai: true,  aiAcc: 0.55 },
  { id: 'hard',   label: '困難',   icon: '🔥', desc: '10秒作答・強化AI對手', time: 10, ai: true,  aiAcc: 0.80 },
  { id: 'expert', label: '地獄',   icon: '💀', desc: '6秒作答・天才AI對手',  time: 6,  ai: true,  aiAcc: 0.92 },
]

const OPTION_COLORS = { A: '#3B82F6', B: '#10B981', C: '#F97316', D: '#EF4444' }

const PRACTICE_HISTORY_KEY = 'practice-history'
const PRACTICE_MAX_RECORDS = 50
const PRACTICE_LAST_CONFIG_KEY = 'practice-last-config'

function savePracticeRecord({ stage, diff, count, correct, total, myScore, aiScore }) {
  const record = {
    id: Date.now(),
    date: new Date().toISOString(),
    stage, diff, count, correct, total, myScore, aiScore,
    pct: total > 0 ? Math.round((correct / total) * 100) : 0,
  }
  try {
    const prev = JSON.parse(localStorage.getItem(PRACTICE_HISTORY_KEY) || '[]')
    const next = [record, ...prev].slice(0, PRACTICE_MAX_RECORDS)
    localStorage.setItem(PRACTICE_HISTORY_KEY, JSON.stringify(next))
  } catch {}
  return record
}

function getPracticeHistory() {
  try { return JSON.parse(localStorage.getItem(PRACTICE_HISTORY_KEY) || '[]') } catch { return [] }
}

function getLastConfig() {
  try { return JSON.parse(localStorage.getItem(PRACTICE_LAST_CONFIG_KEY) || '{}') } catch { return {} }
}

function saveLastConfig(cfg) {
  try { localStorage.setItem(PRACTICE_LAST_CONFIG_KEY, JSON.stringify(cfg)) } catch {}
}

function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/* ── Setup screen ─────────────────────────────────────────────── */
function SetupScreen({ onStart, onBack }) {
  const examType = usePlayerStore(s => s.exam) || 'doctor1'
  const [stages, setStages] = useState([{ id: 0, name: '全部題目', icon: '🎲', color: '#64748B' }])
  const last = getLastConfig()
  const [stage, setStage]     = useState(last.stage ?? 0)
  const [diff, setDiff]       = useState(last.diff ?? 'medium')
  const [count, setCount]     = useState(last.count ?? 10)
  const hasSharedBanks = examHasSharedBanks(examType)
  const [sourceMode, setSourceMode] = useState(() => getSourceMode(examType))
  const [meta, setMeta] = useState(null)
  const [showModeInfo, setShowModeInfo] = useState(false)
  const [online, setOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine : true))

  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  useEffect(() => {
    fetch(`${BACKEND}/meta?exam=${examType}`)
      .then(r => r.json())
      .then(data => {
        if (data.stages) setStages(formatStages(data.stages))
        setMeta(data)
      })
      .catch(() => {})
  }, [examType])

  useEffect(() => { setSourceMode(getSourceMode(examType)) }, [examType])
  const toggleSourceMode = (m) => {
    setSourceMode(m)
    saveSourceMode(examType, m)
  }
  const history = getPracticeHistory()
  const recentPct = history.slice(0, 10)

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      <div className="px-4 pt-14 pb-6 grad-header">
        <button onClick={onBack} className="text-white/50 text-sm mb-2 flex items-center gap-1 active:opacity-70">‹ 返回</button>
        <h1 className="text-white font-bold text-2xl">設定練習模式</h1>
      </div>

      <div className="flex-1 px-4 py-5 flex flex-col gap-5 overflow-y-auto">

        {/* Source mode toggle (only when exam has sharedBanks) */}
        {hasSharedBanks && (
          <div>
            <div className="flex items-center justify-between mb-2.5">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest">題目來源</p>
              <div className="flex items-center gap-1.5">
                <span
                  className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                    online
                      ? 'text-emerald-600 bg-emerald-50 border-emerald-200'
                      : 'text-red-500 bg-red-50 border-red-200'
                  }`}
                  title={online ? '已連線,共享題庫可正常更新' : '目前離線,僅能使用已快取的題目'}
                >
                  {online ? '🟢 可離線練習' : '🔴 離線模式'}
                </span>
                <button
                  type="button"
                  onClick={() => setShowModeInfo(v => !v)}
                  className="text-xs text-gray-400 hover:text-medical-blue"
                  aria-label="題目來源說明"
                >ⓘ</button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => toggleSourceMode('pure')}
                className={`py-3 rounded-xl font-bold text-sm border transition-all active:scale-95
                  ${sourceMode === 'pure'
                    ? 'bg-medical-blue text-white border-medical-blue shadow'
                    : 'bg-white text-gray-700 border-gray-100 shadow-sm'}`}
              >
                📄 歷屆真題
              </button>
              <button
                type="button"
                onClick={() => toggleSourceMode('reservoir')}
                className={`py-3 rounded-xl font-bold text-sm border transition-all active:scale-95
                  ${sourceMode === 'reservoir'
                    ? 'bg-medical-blue text-white border-medical-blue shadow'
                    : 'bg-white text-gray-700 border-gray-100 shadow-sm'}`}
              >
                🌊 大水庫
              </button>
            </div>
            {showModeInfo && (
              <div className="mt-2 p-3 bg-white rounded-xl border border-gray-100 text-[11px] text-gray-500 leading-relaxed">
                <p><strong className="text-medical-dark">歷屆真題</strong>：只從本考試自己的歷屆題出題。</p>
                <p className="mt-1"><strong className="text-medical-dark">大水庫</strong>：加入同等級其他考試的共同科目題，加強刷題量。</p>
                {meta?.totalQ != null && (
                  <p className="mt-1 text-gray-400">共 {meta.totalQ} 題 · 題庫更新：{new Date().toISOString().slice(0, 10)}</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Subject */}
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2.5">選擇科目</p>
          <div className={`grid gap-2 ${stages.length > 6 ? 'grid-cols-3' : 'grid-cols-2'}`}>
            {stages.map(s => (
              <button key={s.id} onClick={() => setStage(s.id)}
                      className={`flex items-center gap-2 px-2.5 py-2.5 rounded-xl text-sm font-medium transition-all active:scale-95 border
                        ${stage === s.id ? 'text-white border-transparent shadow' : 'bg-white text-gray-700 border-gray-100 shadow-sm'}`}
                      style={stage === s.id ? { background: s.color } : {}}>
                <span className="text-lg shrink-0">{s.icon}</span>
                <span className="text-left leading-tight text-[11px]">{s.name}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Difficulty */}
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2.5">難度</p>
          <div className="flex flex-col gap-2">
            {DIFFICULTIES.map(d => (
              <button key={d.id} onClick={() => setDiff(d.id)}
                      className={`flex items-center gap-3 px-4 py-3.5 rounded-xl border transition-all active:scale-95
                        ${diff === d.id ? 'bg-medical-blue border-medical-blue text-white shadow' : 'bg-white border-gray-100 text-gray-700 shadow-sm'}`}>
                <span className="text-2xl">{d.icon}</span>
                <div className="text-left flex-1">
                  <p className="font-bold">{d.label}</p>
                  <p className={`text-xs mt-0.5 ${diff === d.id ? 'text-white/60' : 'text-gray-400'}`}>{d.desc}</p>
                </div>
                {diff === d.id && <span className="text-white">✓</span>}
              </button>
            ))}
          </div>
        </div>

        {/* Question count */}
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2.5">題數</p>
          <div className="flex gap-2">
            {[5, 10, 20, 30].map(n => (
              <button key={n} onClick={() => setCount(n)}
                      className={`flex-1 py-3 rounded-xl font-bold text-base border transition-all active:scale-95
                        ${count === n ? 'bg-medical-blue text-white border-medical-blue shadow' : 'bg-white text-gray-700 border-gray-100 shadow-sm'}`}>
                {n}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Recent accuracy trend */}
      {recentPct.length > 0 && (
        <div className="px-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">最近正確率</p>
          <div className="bg-white rounded-xl p-3 shadow-sm border border-gray-100">
            <div className="flex items-end gap-1 h-12">
              {recentPct.slice().reverse().map((r, i) => (
                <div key={r.id} className="flex-1 flex flex-col items-center gap-0.5">
                  <div className="w-full rounded-t"
                       style={{
                         height: `${Math.max(r.pct * 0.4, 4)}px`,
                         background: r.pct >= 70 ? '#10B981' : r.pct >= 50 ? '#F97316' : '#EF4444',
                       }} />
                </div>
              ))}
            </div>
            <div className="flex justify-between text-[10px] text-gray-400 mt-1">
              <span>舊</span>
              <span>平均 {Math.round(recentPct.reduce((a, r) => a + r.pct, 0) / recentPct.length)}%</span>
              <span>新</span>
            </div>
          </div>
        </div>
      )}

      <div className="px-4 pb-10">
        <button
          onClick={() => {
            saveLastConfig({ stage, diff, count })
            const s = stages.find(s => s.id === stage)
            onStart({ stage, diff, count, stageName: s?.name || '練習', sourceMode })
          }}
          className="w-full py-5 rounded-2xl font-bold text-xl text-white shadow-lg active:scale-95 transition-transform grad-cta"
        >
          🚀 開始練習
        </button>
      </div>
    </div>
  )
}

/* ── Practice game screen ─────────────────────────────────────── */
function PracticeGame({ config, onFinish }) {
  const { play } = useSound()
  const examType = usePlayerStore(s => s.exam) || 'doctor1'
  const diffConfig = DIFFICULTIES.find(d => d.id === config.diff)
  const stageInfo  = { name: config.stageName || '練習', icon: '📝' }

  const [questions, setQuestions] = useState([])
  const [qIdx, setQIdx]           = useState(0)
  const [myAnswer, setMyAnswer]   = useState(null)
  const [aiAnswer, setAiAnswer]   = useState(null)
  const [revealed, setRevealed]   = useState(false)
  const [timeLeft, setTimeLeft]   = useState(diffConfig.time)
  const [myScore, setMyScore]     = useState(0)
  const [aiScore, setAiScore]     = useState(0)
  const [loading, setLoading]     = useState(true)
  const [timerActive, setTimerActive] = useState(false)
  const [explainRequested, setExplainRequested] = useState(false)
  const [showFolderPick, setShowFolderPick] = useState(false)
  const { isBookmarked, getFolder, folders, addToFolder, removeBookmark, getFolderQuestions, MAX_PER_FOLDER } = useBookmarks()
  const sessionLog = useRef([])   // track every q+answer for review

  const { text: explainText, loading: explainLoading, limitHit: explainLimitHit, notEnoughCoins: explainNoCoins, explain, reset: resetExplain, remaining: explainRemaining, cost: explainCost, meta: explainMeta, vote: explainVote } = useExplain()

  // Load questions — use fast /random endpoint
  useEffect(() => {
    const exam = usePlayerStore.getState().exam || 'doctor1'
    const modeParam = config.sourceMode ? `&mode=${config.sourceMode}` : ''
    fetch(`${BACKEND}/questions/random?stage_id=${config.stage}&count=${config.count}&exam=${exam}${modeParam}`)
      .then(r => r.json())
      .then(data => {
        setQuestions(data.questions)
        setLoading(false)
        setTimerActive(true)
      })
  }, [])

  const q = questions[qIdx]

  // Timer
  useEffect(() => {
    if (!timerActive || revealed || loading) return
    if (timeLeft <= 0) { handleTimeUp(); return }
    const t = setTimeout(() => setTimeLeft(t => t - 1), 1000)
    return () => clearTimeout(t)
  }, [timeLeft, timerActive, revealed, loading])

  const handleTimeUp = useCallback(() => {
    if (revealed) return
    reveal(null)
  }, [q, revealed])

  const reveal = (chosen) => {
    if (revealed) return
    setTimerActive(false)
    setMyAnswer(chosen)
    setRevealed(true)

    const correct = q?.answer
    const isCorrect = chosen === correct

    // AI answer
    let aiChoice = null
    if (diffConfig.ai) {
      const rand = Math.random()
      if (rand < diffConfig.aiAcc) {
        aiChoice = correct
      } else {
        const wrong = Object.keys(q.options).filter(k => k !== correct)
        aiChoice = wrong[Math.floor(Math.random() * wrong.length)]
      }
    }
    setAiAnswer(aiChoice)

    if (isCorrect) { setMyScore(s => s + 100); play('correct') }
    else play('wrong')
    if (aiChoice === correct && diffConfig.ai) setAiScore(s => s + 100)

    // Record per-subject accuracy (shared-bank questions route to cross-exam pool).
    // Skip deprecated questions so stale legal items don't pollute weakness/progress.
    const tag = q?.subject_tag || q?.subject_tags?.[0] || q?.subject_name
    const bankId = q?.isSharedBank ? q.sourceBankId : null
    if (tag && !q?.is_deprecated) useAccuracyStore.getState().record(examType, tag, isCorrect, bankId)

    // Log for review
    sessionLog.current.push({
      ...q, user_answer: chosen,
    })
  }

  const handleAnswer = (letter) => {
    if (revealed) return
    navigator.vibrate?.(15)
    reveal(letter)
  }

  const next = () => {
    resetExplain()
    setExplainRequested(false)
    if (qIdx + 1 >= questions.length) {
      const finalScore = myScore + (myAnswer === q?.answer ? 100 : 0)
      onFinish({ myScore: finalScore, aiScore, total: questions.length, log: sessionLog.current })
      return
    }
    setQIdx(i => i + 1)
    setMyAnswer(null)
    setAiAnswer(null)
    setRevealed(false)
    setTimeLeft(diffConfig.time)
    setTimerActive(true)
  }

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 min-h-dvh bg-medical-blue">
        <span className="text-5xl animate-bounce">⚕️</span>
        <p className="text-white text-lg font-bold">載入題目中...</p>
      </div>
    )
  }
  if (!q) return null

  const timePct = (timeLeft / diffConfig.time) * 100
  const timeColor = timeLeft > diffConfig.time * 0.5 ? '#16A34A' : timeLeft > diffConfig.time * 0.25 ? '#D97706' : '#DC2626'
  const progressPct = (qIdx / questions.length) * 100

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">

      {/* ── Top bar ─────────────────────────────────────────── */}
      <div className="px-4 pt-12 pb-3 grad-header">
        {/* Progress */}
        <div className="flex items-center justify-between text-white text-xs mb-1.5">
          <span>{stageInfo.icon} {stageInfo.name}</span>
          <span className="font-bold">{qIdx + 1} / {questions.length}</span>
        </div>
        <div className="w-full h-1.5 bg-white/20 rounded-full mb-3">
          <div className="h-full bg-white rounded-full transition-all duration-300"
               style={{ width: `${progressPct}%` }} />
        </div>

        {/* Scores */}
        <div className="flex gap-2">
          <div className="flex-1 bg-white/15 rounded-xl px-3 py-2 text-white">
            <p className="text-white/50 text-xs">你</p>
            <p className="font-bold text-xl">{myScore}</p>
          </div>
          {diffConfig.ai && (
            <div className="flex-1 bg-white/10 rounded-xl px-3 py-2 text-white">
              <p className="text-white/50 text-xs">🤖 AI ({diffConfig.label})</p>
              <p className="font-bold text-xl">{aiScore}</p>
            </div>
          )}
          <div className="flex flex-col items-center justify-center px-3">
            <span className="font-mono font-bold text-3xl leading-none"
                  style={{ color: timeColor }}>{timeLeft}</span>
            <span className="text-white/30 text-xs">秒</span>
          </div>
        </div>
      </div>

      {/* Timer bar */}
      <div className="h-2 bg-gray-200">
        <div className="h-full transition-all duration-1000 ease-linear rounded-r-full"
             style={{ width: `${timePct}%`, background: timeColor }} />
      </div>

      {/* ── Question ─────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="bg-white rounded-2xl p-4 mb-4 shadow-sm">
          {(q.subject_name || q.roc_year) && (
            <div className="flex items-center gap-2 mb-2">
              {q.subject_name && (
                <span className="text-xs font-semibold text-white px-2 py-0.5 rounded-full"
                      style={{ background: getSubjectColor(q.subject_name) }}>
                  {q.subject_name}
                </span>
              )}
              <span className="text-xs text-gray-400 font-mono">
                {q.roc_year && q.session
                  ? `${q.roc_year}(${q.session === '第一次' ? '一' : '二'})-${q.number}`
                  : q.number ? `#${q.number}` : ''}
              </span>
            </div>
          )}
          {q.is_deprecated && (
            <div className="mb-3 bg-red-50 border-l-4 border-red-400 rounded-r-xl px-3 py-2">
              <p className="text-xs font-bold text-red-600">⚠️ 此題對應條文已修正</p>
              {q.deprecated_reason && (
                <p className="text-xs text-red-500 mt-0.5 leading-relaxed">{q.deprecated_reason}</p>
              )}
              <p className="text-[11px] text-red-400 mt-1">原答案僅供歷史參考,本題不計入弱點與任務進度</p>
            </div>
          )}
          <p className="text-gray-800 font-medium leading-relaxed text-sm">{q.question}</p>
          <QuestionImages images={q.images} imageUrl={q.image_url} incomplete={q.incomplete} />
        </div>

        <div className="flex flex-col gap-2.5">
          {Object.entries(q.options).map(([letter, text]) => {
            const isMyPick   = myAnswer === letter
            const isAiPick   = aiAnswer === letter && diffConfig.ai
            const isCorrect  = revealed && q.answer === letter
            const isWrong    = revealed && isMyPick && !isCorrect

            let bg = 'bg-white border-gray-100'
            let textCls = 'text-gray-700'
            if (isCorrect)      { bg = 'border-transparent'; textCls = 'text-white' }
            else if (isWrong)   { bg = 'bg-red-50 border-red-300'; textCls = 'text-red-700' }
            else if (isMyPick)  { bg = 'border-medical-blue'; textCls = 'text-medical-blue' }

            return (
              <button key={letter}
                      onClick={() => handleAnswer(letter)}
                      disabled={revealed}
                      className={`flex items-start gap-3 px-4 py-3.5 rounded-2xl border-2 text-sm text-left transition-all active:scale-95 shadow-sm
                        ${bg} ${textCls}`}
                      style={isCorrect ? { background: stageInfo.color, borderColor: stageInfo.color } : {}}>
                <span className="font-bold w-5 shrink-0 text-base"
                      style={isCorrect ? { color: 'white' } : { color: OPTION_COLORS[letter] }}>
                  {letter}
                </span>
                <span className="flex-1 leading-snug">{text}</span>
                <div className="shrink-0 flex flex-col items-end gap-0.5">
                  {isCorrect  && <span className="text-white">✓</span>}
                  {isWrong    && <span className="text-red-400">✗</span>}
                  {isAiPick && revealed && (
                    <span className="text-xs bg-black/20 text-white px-1.5 py-0.5 rounded-full">AI</span>
                  )}
                </div>
              </button>
            )
          })}
        </div>

        {/* AI answer hint (when not picked same) */}
        {revealed && diffConfig.ai && aiAnswer && aiAnswer !== myAnswer && (
          <div className="mt-3 bg-white rounded-xl px-4 py-3 shadow-sm border border-gray-100 text-sm text-gray-500 flex items-center gap-2">
            <span>🤖</span>
            <span>AI 選了 <strong>{aiAnswer}</strong>（
              {aiAnswer === q.answer ? <span className="text-green-600">答對了</span> : <span className="text-red-500">答錯了</span>}）
            </span>
          </div>
        )}

        {/* Bookmark */}
        {revealed && q && (
          <div className="mt-3 flex items-center gap-2">
            <button onClick={() => isBookmarked(q) ? removeBookmark(q) : setShowFolderPick(!showFolderPick)}
              className={`flex items-center gap-1.5 text-sm font-bold px-3 py-2 rounded-xl active:scale-95 transition-all border ${isBookmarked(q) ? 'bg-amber-50 text-amber-600 border-amber-200' : 'bg-gray-50 text-gray-500 border-gray-200'}`}>
              {isBookmarked(q) ? '⭐ 已收藏' : '☆ 收藏'}
              {isBookmarked(q) && <span className="text-xs opacity-60">({getFolder(q)})</span>}
            </button>
            {showFolderPick && !isBookmarked(q) && folders.map(f => {
              const count = getFolderQuestions(f).length
              const full = count >= MAX_PER_FOLDER
              return (
                <button key={f} onClick={() => { if (!full) { addToFolder(q, f); setShowFolderPick(false) } }}
                  disabled={full}
                  className={`text-xs font-bold px-3 py-2 rounded-xl border active:scale-95 ${full ? 'bg-gray-50 text-gray-300 border-gray-100' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                  {f} ({count}/{MAX_PER_FOLDER})
                </button>
              )
            })}
          </div>
        )}

        {/* AI Explain */}
        {revealed && (
          <div className="mt-3">
            <ExplainPanel
              text={explainText}
              loading={explainLoading}
              limitHit={explainLimitHit}
              notEnoughCoins={explainNoCoins}
              remaining={explainRemaining}
              cost={explainCost}
              requested={explainRequested}
              onRequest={() => {
                setExplainRequested(true)
                explain({ ...q, user_answer: myAnswer })
              }}
              answer={q?.answer}
              options={q?.options}
              explanation={q?.explanation}
              questionId={q?.id}
              questionText={q?.question}
              rocYear={q?.roc_year}
              session={q?.session}
              number={q?.number}
              disputed={q?.disputed}
              subjectTags={q?.subject_tags}
              meta={explainMeta}
              onVote={explainVote}
            />
            {q?.id && <CommentSection targetId={`q_${q.id}`} />}
          </div>
        )}

        {/* Next button */}
        {revealed && (
          <button onClick={next}
                  className="w-full mt-3 py-4 rounded-2xl font-bold text-lg text-white active:scale-95 transition-transform shadow-lg grad-cta">
            {qIdx + 1 >= questions.length ? '查看結果 →' : '下一題 →'}
          </button>
        )}

        {!revealed && (
          <p className="text-center text-xs text-gray-400 mt-4">點選選項或等待倒數</p>
        )}
      </div>
    </div>
  )
}

/* ── Practice results screen ──────────────────────────────────── */
function PracticeResults({ result, config, onRestart, onHome }) {
  const { addCoins, addExp } = usePlayerStore()
  const { play } = useSound()
  const { text: reviewText, loading: reviewLoading, review, notEnoughCoins: reviewNoCoins, cost: reviewCost } = useReview()
  const [reviewRequested, setReviewRequested] = useState(false)
  const diffConfig = DIFFICULTIES.find(d => d.id === config.diff)
  const correct = result.myScore / 100
  const total   = result.total
  const pct     = Math.round((correct / total) * 100)
  const won     = !diffConfig.ai || result.myScore >= result.aiScore

  useEffect(() => {
    play(won ? 'victory' : 'defeat')
    const meetsThreshold = pct >= 70
    if (meetsThreshold) {
      addCoins(won ? 60 : 20)
      addExp(correct * 10)
    }
    savePracticeRecord({
      stage: config.stage, diff: config.diff, count: config.count,
      correct, total, myScore: result.myScore, aiScore: result.aiScore,
    })
    // Submit per-question stats (skip deprecated questions)
    if (result.log && result.log.length > 0) {
      const stats = result.log.filter(q => q.id && !q.is_deprecated).map(q => ({
        questionId: q.id,
        correct: q.user_answer === q.answer,
      }))
      if (stats.length > 0) {
        fetch(`${BACKEND}/questions/track`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stats }),
        }).catch(() => {})
      }
    }
    // Submit to leaderboard — attach userId so legal_guardian badge (and future
    // achievements) can be joined back on the leaderboard endpoint.
    const playerName = usePlayerStore.getState().name
    if (playerName) {
      ;(async () => {
        let userId = null
        try {
          const { data } = await supabase?.auth.getSession() || {}
          userId = data?.session?.user?.id || null
        } catch {}
        fetch(`${BACKEND}/leaderboard/submit`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: playerName,
            correct,
            total,
            level: usePlayerStore.getState().level,
            examId: usePlayerStore.getState().exam,
            userId,
          }),
        }).catch(() => {})
      })()
    }
  }, [])

  const grade = pct >= 90 ? ['S', '#D97706'] : pct >= 75 ? ['A', '#10B981'] :
                pct >= 60 ? ['B', '#3B82F6'] : pct >= 40 ? ['C', '#8B5CF6'] : ['D', '#EF4444']

  return (
    <div className="flex flex-col min-h-dvh grad-header">
      <div className="flex-1 flex flex-col items-center justify-center px-5 gap-5 pt-16">
        {/* Grade circle */}
        <div className="w-32 h-32 rounded-full border-4 flex items-center justify-center shadow-2xl bg-white/10"
             style={{ borderColor: grade[1] }}>
          <span className="font-black text-6xl" style={{ color: grade[1] }}>{grade[0]}</span>
        </div>

        <div className="text-center">
          <p className="text-white font-bold text-3xl">{pct}%</p>
          <p className="text-white/60 text-sm mt-1">{correct} / {total} 題答對</p>
        </div>

        {diffConfig.ai && (
          <div className="flex gap-4">
            <div className="bg-white/15 rounded-2xl px-6 py-4 text-center">
              <p className="text-white/50 text-xs mb-1">你的得分</p>
              <p className="text-white font-bold text-2xl">{result.myScore}</p>
            </div>
            <div className="bg-white/10 rounded-2xl px-6 py-4 text-center">
              <p className="text-white/50 text-xs mb-1">🤖 AI 得分</p>
              <p className="text-white font-bold text-2xl">{result.aiScore}</p>
            </div>
          </div>
        )}

        <p className="text-white/60 text-sm">
          {pct < 70 ? '正確率未達 70%，無金幣獎勵' : won ? '🏆 你贏了！+60 金幣' : '💪 繼續加油！+20 金幣'}
        </p>

        {/* Share challenge — Web Share API → clipboard fallback, deep-links receiver */}
        <ShareChallengeButton
          exam={usePlayerStore.getState().exam || 'doctor1'}
          subject={config.stage || null}
          examName={getExamConfig(usePlayerStore.getState().exam || 'doctor1')?.name || '國考'}
          subjectName={config.stageName || null}
          correct={correct}
          total={total}
          mode="practice"
        />
      </div>

      <div className="px-5 pb-12 flex flex-col gap-3">
        {/* AI Review */}
        <ReviewPanel
          text={reviewText}
          loading={reviewLoading}
          requested={reviewRequested}
          notEnoughCoins={reviewNoCoins}
          cost={reviewCost}
          onRequest={() => {
            setReviewRequested(true)
            review(result.log || [], 'practice')
          }}
        />

        <button onClick={onRestart}
                className="w-full py-4 rounded-2xl font-bold text-lg bg-white/15 text-white border border-white/20 active:scale-95 transition-transform">
          🔄 再練一次
        </button>
        <button onClick={onHome}
                className="w-full py-4 rounded-2xl font-bold text-lg text-white active:scale-95 transition-transform grad-cta-green">
          🏠 回主畫面
        </button>

        <SmartBanner />
      </div>
    </div>
  )
}

/* ── Page entry ───────────────────────────────────────────────── */
export default function Practice() {
  const navigate = useNavigate()
  const [phase, setPhase]   = useState('setup')  // setup | game | results
  const [config, setConfig] = useState(null)
  const [result, setResult] = useState(null)
  const examId = usePlayerStore(s => s.exam) || 'doctor1'
  const examCfg = getExamConfig(examId)
  const examName = examCfg?.name || '國考'
  usePageMeta(
    `${examName} 練習模式`,
    `${examName}歷屆考古題線上練習，涵蓋所有科目與年度，支援大水庫模式、AI 解說、即時對戰，免費使用！`,
    { canonical: `https://examking.tw/practice?exam=${examId}` }
  )

  if (phase === 'setup') {
    return <SetupScreen onStart={cfg => { setConfig(cfg); setPhase('game') }} onBack={() => navigate('/')} />
  }
  if (phase === 'game') {
    return <PracticeGame config={config} onFinish={r => { setResult(r); setPhase('results') }} />
  }
  return (
    <PracticeResults
      result={result} config={config}
      onRestart={() => setPhase('setup')}
      onHome={() => navigate('/')}
    />
  )
}
