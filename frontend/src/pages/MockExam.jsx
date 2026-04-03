import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/gameStore'
import SmartBanner from '../components/SmartBanner'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

const PAPERS = [
  { id: 'paper1', name: '基礎醫學(一)', stages: '1,2,3,4,10', subjects: '解剖、生理、生化、組織、胚胎' },
  { id: 'paper2', name: '基礎醫學(二)', stages: '5,6,7,8,9', subjects: '微免、寄生蟲、藥理、病理、公衛' },
]

const TIME_LIMIT = 120 * 60 // 120 minutes in seconds
const PASS_RATE = 0.6

const OPTION_COLORS = { A: '#3B82F6', B: '#10B981', C: '#F59E0B', D: '#EF4444' }

// ── Setup screen ─────────────────────────────────────────────────
function ExamSetup({ onStart }) {
  const [paper, setPaper] = useState('paper1')

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      <div className="px-4 pt-14 pb-6 grad-header">
        <h1 className="text-white font-bold text-2xl">📝 模擬考</h1>
        <p className="text-white/60 text-sm mt-1">模擬國考實戰，100 題 / 120 分鐘</p>
      </div>

      <div className="flex-1 px-4 py-5 flex flex-col gap-4">
        <div>
          <p className="text-sm font-bold text-gray-700 mb-3">選擇考卷</p>
          <div className="flex flex-col gap-3">
            {PAPERS.map(p => (
              <button key={p.id} onClick={() => setPaper(p.id)}
                className={`w-full text-left rounded-2xl px-5 py-4 border-2 transition-all active:scale-[0.97]
                  ${paper === p.id ? 'border-medical-blue bg-blue-50 shadow' : 'border-gray-100 bg-white'}`}>
                <p className={`font-bold text-lg ${paper === p.id ? 'text-medical-blue' : 'text-medical-dark'}`}>{p.name}</p>
                <p className="text-gray-400 text-xs mt-1">{p.subjects}</p>
              </button>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
          <p className="text-sm font-bold text-gray-700 mb-2">考試規則</p>
          <div className="text-xs text-gray-500 space-y-1.5">
            <p>📋 100 題選擇題，隨機出題</p>
            <p>⏱️ 限時 120 分鐘</p>
            <p>✅ 每題 1 分，滿分 100 分</p>
            <p>🎯 及格標準：60 分（答對 60 題）</p>
            <p>❌ 答錯不倒扣</p>
            <p>📌 可跳題作答，最後統一交卷</p>
          </div>
        </div>

        <button onClick={() => onStart(PAPERS.find(p => p.id === paper))}
          className="w-full py-5 rounded-2xl font-bold text-xl text-white shadow-lg active:scale-95 transition-transform grad-cta">
          🚀 開始考試
        </button>
      </div>
    </div>
  )
}

// ── Exam in progress ─────────────────────────────────────────────
function ExamInProgress({ paper, questions, onFinish }) {
  const [answers, setAnswers] = useState({}) // { index: 'A'|'B'|'C'|'D' }
  const [qIdx, setQIdx] = useState(0)
  const [timeLeft, setTimeLeft] = useState(TIME_LIMIT)
  const [showNav, setShowNav] = useState(false)
  const timerRef = useRef(null)

  useEffect(() => {
    timerRef.current = setInterval(() => {
      setTimeLeft(t => {
        if (t <= 1) { clearInterval(timerRef.current); onFinish(answers); return 0 }
        return t - 1
      })
    }, 1000)
    return () => clearInterval(timerRef.current)
  }, [])

  const selectAnswer = (letter) => {
    navigator.vibrate?.(15)
    setAnswers(prev => ({ ...prev, [qIdx]: letter }))
  }

  const answeredCount = Object.keys(answers).length
  const q = questions[qIdx]
  const mm = Math.floor(timeLeft / 60)
  const ss = timeLeft % 60
  const timeStr = `${mm}:${ss.toString().padStart(2, '0')}`
  const timeUrgent = timeLeft < 300

  const handleSubmit = () => {
    clearInterval(timerRef.current)
    onFinish(answers)
  }

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      {/* Header */}
      <div className="sticky top-0 z-10 grad-header px-4 pt-12 pb-3">
        <div className="flex items-center justify-between text-white text-xs mb-1.5">
          <span>{paper.name}</span>
          <span className={timeUrgent ? 'text-red-300 font-bold animate-pulse' : ''}>{timeStr}</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex-1 h-2 bg-white/20 rounded-full overflow-hidden">
            <div className="h-full bg-white/70 rounded-full transition-all duration-300"
                 style={{ width: `${(answeredCount / questions.length) * 100}%` }} />
          </div>
          <span className="text-white text-xs font-bold">{answeredCount}/{questions.length}</span>
        </div>
      </div>

      {/* Question */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="bg-white rounded-2xl p-4 mb-4 shadow-sm">
          <p className="text-xs text-gray-400 mb-2">第 {qIdx + 1} / {questions.length} 題</p>
          <p className="text-gray-800 font-medium leading-relaxed text-sm">{q.question}</p>
        </div>

        <div className="flex flex-col gap-2.5">
          {Object.entries(q.options).map(([letter, text]) => {
            const selected = answers[qIdx] === letter
            return (
              <button key={letter} onClick={() => selectAnswer(letter)}
                className={`flex items-start gap-3 px-4 py-3.5 rounded-2xl border-2 text-sm text-left transition-all active:scale-95 shadow-sm
                  ${selected ? 'border-medical-blue bg-blue-50' : 'bg-white border-gray-100'}`}>
                <span className="font-bold w-5 shrink-0 text-base" style={{ color: OPTION_COLORS[letter] }}>{letter}</span>
                <span className={`flex-1 leading-snug ${selected ? 'text-medical-blue font-medium' : 'text-gray-700'}`}>{text}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Bottom nav */}
      <div className="sticky bottom-0 bg-white border-t border-gray-100 px-4 py-3 flex items-center gap-3">
        <button onClick={() => setQIdx(i => Math.max(0, i - 1))} disabled={qIdx === 0}
          className="px-4 py-3 rounded-xl font-bold text-sm bg-gray-100 text-gray-600 disabled:opacity-30 active:scale-95">
          ‹ 上一題
        </button>
        <button onClick={() => setShowNav(!showNav)}
          className="flex-1 py-3 rounded-xl font-bold text-sm bg-medical-ice text-medical-dark border border-gray-200 active:scale-95">
          🗂️ 題目導覽
        </button>
        {qIdx < questions.length - 1 ? (
          <button onClick={() => setQIdx(i => i + 1)}
            className="px-4 py-3 rounded-xl font-bold text-sm text-white grad-cta active:scale-95">
            下一題 ›
          </button>
        ) : (
          <button onClick={handleSubmit}
            className="px-4 py-3 rounded-xl font-bold text-sm text-white bg-red-500 active:scale-95">
            交卷
          </button>
        )}
      </div>

      {/* Question navigator overlay */}
      {showNav && (
        <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={() => setShowNav(false)}>
          <div className="w-full max-w-[430px] bg-white rounded-t-3xl px-5 pb-8 pt-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-4" />
            <div className="flex items-center justify-between mb-3">
              <p className="font-bold text-gray-700">題目導覽</p>
              <button onClick={handleSubmit} className="text-sm font-bold text-red-500 active:scale-95">交卷 →</button>
            </div>
            <div className="grid grid-cols-10 gap-1.5">
              {questions.map((_, i) => (
                <button key={i} onClick={() => { setQIdx(i); setShowNav(false) }}
                  className={`w-full aspect-square rounded-lg text-xs font-bold flex items-center justify-center transition-all
                    ${i === qIdx ? 'ring-2 ring-medical-blue' : ''}
                    ${answers[i] ? 'bg-medical-blue text-white' : 'bg-gray-100 text-gray-400'}`}>
                  {i + 1}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Results screen ───────────────────────────────────────────────
function ExamResults({ paper, questions, answers, timeUsed }) {
  const navigate = useNavigate()
  const { addCoins, addExp } = usePlayerStore()
  const [saved, setSaved] = useState(false)

  const correct = questions.filter((q, i) => answers[i] === q.answer).length
  const total = questions.length
  const score = correct
  const pct = Math.round((correct / total) * 100)
  const passed = pct >= PASS_RATE * 100
  const mm = Math.floor(timeUsed / 60)
  const ss = timeUsed % 60

  useEffect(() => {
    if (saved) return
    setSaved(true)
    addCoins(passed ? 200 : 50)
    addExp(passed ? 150 : 40)
    // Save to localStorage
    try {
      const key = 'mock-exam-history'
      const prev = JSON.parse(localStorage.getItem(key) || '[]')
      prev.unshift({ date: new Date().toISOString(), paper: paper.name, score, total, pct, passed, timeUsed })
      localStorage.setItem(key, JSON.stringify(prev.slice(0, 20)))
    } catch {}
  }, [])

  const wrongQuestions = questions
    .map((q, i) => ({ ...q, myAnswer: answers[i] || null, correct: answers[i] === q.answer }))
    .filter(q => !q.correct)

  return (
    <div className="flex flex-col min-h-dvh grad-header">
      <div className="flex-1 flex flex-col items-center justify-center px-5 gap-5 pt-16">
        {/* Score circle */}
        <div className={`w-36 h-36 rounded-full border-4 flex flex-col items-center justify-center shadow-2xl bg-white/10
          ${passed ? 'border-green-400' : 'border-red-400'}`}>
          <span className="text-5xl font-black text-white">{score}</span>
          <span className="text-white/60 text-xs">/ {total}</span>
        </div>

        <div className="text-center">
          <h1 className="text-3xl font-bold text-white mb-1">{passed ? '🎉 及格！' : '😤 再接再厲'}</h1>
          <p className="text-white/60 text-sm">{paper.name}</p>
        </div>

        <div className="flex gap-4">
          <div className="bg-white/10 rounded-xl px-4 py-2 text-center">
            <p className="text-white/50 text-xs">正確率</p>
            <p className="text-white font-bold text-lg">{pct}%</p>
          </div>
          <div className="bg-white/10 rounded-xl px-4 py-2 text-center">
            <p className="text-white/50 text-xs">用時</p>
            <p className="text-white font-bold text-lg">{mm}:{ss.toString().padStart(2, '0')}</p>
          </div>
          <div className="bg-white/10 rounded-xl px-4 py-2 text-center">
            <p className="text-white/50 text-xs">獎勵</p>
            <p className="text-white font-bold text-lg">🪙 {passed ? 200 : 50}</p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-t-3xl px-5 pt-5 pb-10 flex flex-col gap-3">
        {wrongQuestions.length > 0 && (
          <button onClick={() => navigate('/review', { state: { questions: wrongQuestions.map(q => ({ ...q })), stage: paper.name } })}
            className="w-full py-4 rounded-2xl font-bold text-lg border-2 active:scale-95 transition-transform flex items-center justify-center gap-2"
            style={{ borderColor: '#EF4444', color: '#EF4444', background: '#FFF5F5' }}>
            📋 錯題檢討（{wrongQuestions.length} 題）
          </button>
        )}
        <button onClick={() => navigate('/mock-exam')}
          className="w-full py-4 rounded-2xl font-bold text-lg text-white active:scale-95 transition-transform grad-cta">
          🔄 再考一次
        </button>
        <button onClick={() => navigate('/')}
          className="w-full py-4 rounded-2xl font-bold text-lg bg-medical-ice text-medical-dark border border-gray-200 active:scale-95 transition-transform">
          🏠 回主畫面
        </button>
        <SmartBanner />
      </div>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────
export default function MockExam() {
  const navigate = useNavigate()
  const [phase, setPhase] = useState('setup') // setup | loading | exam | results
  const [paper, setPaper] = useState(null)
  const [questions, setQuestions] = useState([])
  const [answers, setAnswers] = useState({})
  const [timeUsed, setTimeUsed] = useState(0)
  const startTime = useRef(0)

  const handleStart = async (selectedPaper) => {
    setPaper(selectedPaper)
    setPhase('loading')
    try {
      const res = await fetch(`${BACKEND}/questions/exam?stages=${selectedPaper.stages}&count=100`)
      const data = await res.json()
      if (data.questions.length < 10) {
        alert('題目不足，請稍後再試')
        setPhase('setup')
        return
      }
      setQuestions(data.questions)
      startTime.current = Date.now()
      setPhase('exam')
    } catch {
      alert('載入失敗，請檢查網路連線')
      setPhase('setup')
    }
  }

  const handleFinish = (finalAnswers) => {
    setAnswers(finalAnswers)
    setTimeUsed(Math.floor((Date.now() - startTime.current) / 1000))
    setPhase('results')
  }

  if (phase === 'setup') return <ExamSetup onStart={handleStart} />

  if (phase === 'loading') {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh bg-medical-ice gap-4">
        <div className="text-5xl animate-bounce">📝</div>
        <p className="text-gray-500 font-medium">正在出題中…</p>
      </div>
    )
  }

  if (phase === 'exam') {
    return <ExamInProgress paper={paper} questions={questions} onFinish={handleFinish} />
  }

  return <ExamResults paper={paper} questions={questions} answers={answers} timeUsed={timeUsed} />
}
