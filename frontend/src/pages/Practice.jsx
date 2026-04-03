import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/gameStore'
import { useSound } from '../hooks/useSound'
import { useExplain, useReview } from '../hooks/useAI'
import { ExplainPanel, ReviewPanel } from '../components/AIPanel'
import SmartBanner from '../components/SmartBanner'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

const STAGES = [
  { id: 0,  name: '隨機混合',   icon: '🎲', color: '#64748B' },
  { id: 1,  name: '解剖學殿堂', icon: '🦴', color: '#3B82F6' },
  { id: 2,  name: '生理學之谷', icon: '💓', color: '#EF4444' },
  { id: 3,  name: '生化迷宮',   icon: '⚗️',  color: '#8B5CF6' },
  { id: 4,  name: '組織學祕境', icon: '🔬', color: '#6366F1' },
  { id: 10, name: '胚胎學源脈', icon: '🧬', color: '#818CF8' },
  { id: 5,  name: '微免聖域',   icon: '🦠', color: '#10B981' },
  { id: 6,  name: '寄生蟲荒原', icon: '🪱', color: '#D97706' },
  { id: 7,  name: '藥理決鬥場', icon: '💊', color: '#F97316' },
  { id: 8,  name: '病理學深淵', icon: '🩺', color: '#DC2626' },
  { id: 9,  name: '公衛學巔峰', icon: '📊', color: '#0D9488' },
]

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
  const last = getLastConfig()
  const [stage, setStage]     = useState(last.stage ?? 0)
  const [diff, setDiff]       = useState(last.diff ?? 'medium')
  const [count, setCount]     = useState(last.count ?? 10)
  const history = getPracticeHistory()
  const recentPct = history.slice(0, 10)

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      <div className="px-4 pt-14 pb-6 grad-header">
        <button onClick={onBack} className="text-white/50 text-sm mb-2 flex items-center gap-1 active:opacity-70">‹ 返回</button>
        <h1 className="text-white font-bold text-2xl">設定練習模式</h1>
      </div>

      <div className="flex-1 px-4 py-5 flex flex-col gap-5 overflow-y-auto">

        {/* Subject */}
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2.5">選擇科目</p>
          <div className="grid grid-cols-2 gap-2">
            {STAGES.map(s => (
              <button key={s.id} onClick={() => setStage(s.id)}
                      className={`flex items-center gap-2.5 px-3 py-3 rounded-xl text-sm font-medium transition-all active:scale-95 border
                        ${stage === s.id ? 'text-white border-transparent shadow' : 'bg-white text-gray-700 border-gray-100 shadow-sm'}`}
                      style={stage === s.id ? { background: s.color } : {}}>
                <span className="text-xl shrink-0">{s.icon}</span>
                <span className="text-left leading-tight text-xs">{s.name}</span>
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
            onStart({ stage, diff, count })
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
  const diffConfig = DIFFICULTIES.find(d => d.id === config.diff)
  const stageInfo  = STAGES.find(s => s.id === config.stage)

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
  const sessionLog = useRef([])   // track every q+answer for review

  const { text: explainText, loading: explainLoading, limitHit: explainLimitHit, explain, reset: resetExplain, remaining: explainRemaining } = useExplain()

  // Load questions — use fast /random endpoint
  useEffect(() => {
    fetch(`${BACKEND}/questions/random?stage_id=${config.stage}&count=${config.count}`)
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
          <p className="text-gray-800 font-medium leading-relaxed text-sm">{q.question}</p>
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

        {/* AI Explain */}
        {revealed && (
          <div className="mt-3">
            <ExplainPanel
              text={explainText}
              loading={explainLoading}
              limitHit={explainLimitHit}
              remaining={explainRemaining}
              requested={explainRequested}
              onRequest={() => {
                setExplainRequested(true)
                explain({ ...q, user_answer: myAnswer })
              }}
              answer={q?.answer}
              options={q?.options}
              explanation={q?.explanation}
            />
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
  const { text: reviewText, loading: reviewLoading, review } = useReview()
  const [reviewRequested, setReviewRequested] = useState(false)
  const diffConfig = DIFFICULTIES.find(d => d.id === config.diff)
  const correct = result.myScore / 100
  const total   = result.total
  const pct     = Math.round((correct / total) * 100)
  const won     = !diffConfig.ai || result.myScore >= result.aiScore

  useEffect(() => {
    play(won ? 'victory' : 'defeat')
    addCoins(won ? 80 : 20)
    addExp(correct * 10)
    savePracticeRecord({
      stage: config.stage, diff: config.diff, count: config.count,
      correct, total, myScore: result.myScore, aiScore: result.aiScore,
    })
    // Submit per-question stats
    if (result.log && result.log.length > 0) {
      const stats = result.log.filter(q => q.id).map(q => ({
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
    // Submit to leaderboard
    const playerName = usePlayerStore.getState().name
    if (playerName) {
      fetch(`${BACKEND}/leaderboard/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: playerName, correct, total, level: usePlayerStore.getState().level }),
      }).catch(() => {})
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

        <p className="text-white/60 text-sm">{won ? '🏆 你贏了！+80 金幣' : '💪 繼續加油！+20 金幣'}</p>

        {/* LINE Share */}
        <button
          onClick={() => {
            const stageName = STAGES.find(s => s.id === config.stage)?.name || '隨機'
            const text = `醫學知識王｜${stageName} ${pct}% (${correct}/${total})\n${won ? '🏆 贏了！' : '💪 繼續加油'}\n一起來挑戰 👉 ${window.location.origin}`
            window.open(`https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(window.location.origin)}&text=${encodeURIComponent(text)}`, '_blank')
          }}
          className="flex items-center justify-center gap-2 bg-[#06C755] text-white font-bold px-6 py-3 rounded-2xl active:scale-95 transition-transform shadow-lg"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M12 2C6.48 2 2 5.82 2 10.5c0 4.21 3.74 7.74 8.79 8.4.34.07.81.23.93.52.1.27.07.68.03.95l-.15.9c-.05.27-.21 1.07.94.58 1.15-.49 6.2-3.65 8.46-6.25C22.97 13.35 22 11.03 22 10.5 22 5.82 17.52 2 12 2z"/></svg>
          分享到 LINE
        </button>
      </div>

      <div className="px-5 pb-12 flex flex-col gap-3">
        {/* AI Review */}
        <ReviewPanel
          text={reviewText}
          loading={reviewLoading}
          requested={reviewRequested}
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
