import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/gameStore'
import QuestionImages from '../components/QuestionImages'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const BOSS_FEE = 50
const OPTION_COLORS = { A: '#3B82F6', B: '#10B981', C: '#F59E0B', D: '#EF4444' }

function BossCard({ q, index, onAnswer, answered }) {
  const [picked, setPicked] = useState(null)
  const [revealed, setRevealed] = useState(false)

  const handlePick = (letter) => {
    if (revealed) return
    navigator.vibrate?.(15)
    setPicked(letter)
    setRevealed(true)
    onAnswer(letter === q.answer)
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-4 py-3 flex items-center justify-between border-b border-gray-50">
        <div className="flex items-center gap-2">
          <span className="text-lg">👹</span>
          <span className="font-bold text-sm text-gray-700">魔王題 #{index + 1}</span>
        </div>
        <span className="text-xs font-bold px-2 py-1 rounded-full bg-red-50 text-red-500">
          {q.wrongRate}% 答錯率
        </span>
      </div>
      <div className="px-4 py-3">
        <p className="text-sm text-gray-800 leading-relaxed mb-3">{q.question}</p>
        <QuestionImages images={q.images} />
        <div className="flex flex-col gap-2">
          {Object.entries(q.options).map(([letter, text]) => {
            const isCorrect = revealed && q.answer === letter
            const isWrong = revealed && picked === letter && !isCorrect
            const isPicked = picked === letter

            let bg = 'bg-white border-gray-100'
            let textCls = 'text-gray-700'
            if (isCorrect) { bg = 'bg-green-50 border-green-400'; textCls = 'text-green-800' }
            else if (isWrong) { bg = 'bg-red-50 border-red-300'; textCls = 'text-red-700' }
            else if (isPicked) { bg = 'border-medical-blue'; textCls = 'text-medical-blue' }

            return (
              <button key={letter} onClick={() => handlePick(letter)}
                disabled={revealed}
                className={`flex items-start gap-2.5 px-3.5 py-3 rounded-xl border-2 text-sm text-left transition-all active:scale-95 ${bg} ${textCls}`}>
                <span className="font-bold w-4 shrink-0" style={{ color: revealed ? undefined : OPTION_COLORS[letter] }}>{letter}</span>
                <span className="flex-1 leading-snug">{text}</span>
                {isCorrect && <span>✓</span>}
                {isWrong && <span>✗</span>}
              </button>
            )
          })}
        </div>
        {revealed && (
          <p className="text-xs text-gray-400 mt-2">
            共 {q.attempts} 人作答，{q.wrongRate}% 答錯
          </p>
        )}
      </div>
    </div>
  )
}

export default function BossChallenge() {
  const navigate = useNavigate()
  const { coins, spendCoins, addCoins } = usePlayerStore()
  const [questions, setQuestions] = useState([])
  const [loading, setLoading] = useState(true)
  const [score, setScore] = useState({ correct: 0, total: 0 })
  const [paid, setPaid] = useState(false)
  const [reward, setReward] = useState(null)

  useEffect(() => {
    if (!spendCoins(BOSS_FEE)) {
      setLoading(false)
      return
    }
    setPaid(true)
    const examType = usePlayerStore.getState().exam || 'doctor1'
    fetch(`${BACKEND}/questions/hardest?count=10&exam=${examType}`)
      .then(r => r.json())
      .then(data => { setQuestions(data.questions || []); setLoading(false) })
      .catch(() => { setLoading(false); addCoins(BOSS_FEE) }) // refund on error
  }, [])

  const handleAnswer = (correct) => {
    setScore(s => {
      const newScore = { correct: s.correct + (correct ? 1 : 0), total: s.total + 1 }
      // Award coins when all questions answered
      if (newScore.total === questions.length && reward === null) {
        const pct = newScore.correct / newScore.total
        const earned = pct >= 0.7 ? 200 : 40
        addCoins(earned)
        setReward(earned)
      }
      return newScore
    })
  }

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      {/* Header */}
      <div className="sticky top-0 z-10 px-4 pt-12 pb-4 grad-header">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="text-white/60 text-2xl leading-none">‹</button>
          <div className="flex-1">
            <h1 className="text-white font-bold text-xl">🔥 魔王題挑戰</h1>
            <p className="text-white/50 text-xs">全台醫學生答錯率最高的題目</p>
          </div>
          {score.total > 0 && (
            <div className="bg-white/15 rounded-xl px-3 py-1.5 text-center">
              <p className="text-white font-bold text-sm">{score.correct}/{score.total}</p>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 px-4 py-4 flex flex-col gap-3">
        {!paid && !loading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <span className="text-5xl">🪙</span>
            <p className="text-gray-500 font-medium">金幣不足！</p>
            <p className="text-gray-400 text-sm">需要 {BOSS_FEE} 金幣，目前只有 {coins} 金幣</p>
            <button onClick={() => navigate('/')}
              className="mt-2 px-6 py-3 rounded-2xl font-bold text-white text-sm active:scale-95 grad-cta">
              回主畫面
            </button>
          </div>
        ) : loading ? (
          <div className="flex flex-col gap-3">
            {[0,1,2].map(i => (
              <div key={i} className="bg-white rounded-2xl p-4 shadow-sm animate-pulse">
                <div className="h-4 bg-gray-200 rounded w-3/4 mb-3" />
                <div className="h-3 bg-gray-200 rounded w-full mb-2" />
                <div className="h-3 bg-gray-200 rounded w-5/6" />
              </div>
            ))}
          </div>
        ) : questions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <span className="text-5xl">📊</span>
            <p className="text-gray-500 font-medium">尚未累積足夠的作答數據</p>
            <p className="text-gray-400 text-sm">多玩幾場對戰，魔王題就會出現！</p>
            <button onClick={() => navigate('/')}
              className="mt-2 px-6 py-3 rounded-2xl font-bold text-white text-sm active:scale-95 grad-cta">
              去對戰
            </button>
          </div>
        ) : (
          <>
            {questions.map((q, i) => (
              <BossCard key={q.id} q={q} index={i} onAnswer={handleAnswer} />
            ))}

            {score.total === questions.length && score.total > 0 && (
              <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100 text-center">
                <p className="text-3xl mb-2">{score.correct >= questions.length * 0.7 ? '🏆' : '💪'}</p>
                <p className="font-bold text-lg text-medical-dark">
                  {score.correct >= questions.length * 0.7 ? '太強了！魔王題都難不倒你' : '繼續努力，下次一定行'}
                </p>
                <p className="text-gray-400 text-sm mt-1">
                  答對 {score.correct} / {score.total} 題魔王題
                </p>
                {reward !== null && (
                  <p className="text-amber-600 font-bold text-sm mt-2">🪙 +{reward} 金幣{reward >= 200 ? ' (入場費 50 → 淨賺 150！)' : ''}</p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
