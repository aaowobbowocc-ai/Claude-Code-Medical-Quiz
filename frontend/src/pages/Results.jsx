import React, { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useGameStore, usePlayerStore } from '../store/gameStore'
import { getSocket } from '../hooks/useSocket'
import { useSound } from '../hooks/useSound'
import SmartBanner from '../components/SmartBanner'
import ShareChallengeButton from '../components/ShareChallengeButton'
import { getExamConfig } from '../config/examRegistry'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const HISTORY_KEY = 'battle-history'
const MAX_RECORDS = 30

function saveBattleRecord({ myName, myScore, rank, totalPlayers, stage, opponents, questionResults }) {
  const record = {
    id: Date.now(),
    date: new Date().toISOString(),
    stage,
    myName,
    myScore,
    rank,
    totalPlayers,
    opponents,
    correctCount: questionResults.filter(q => q.correct).length,
    totalCount: questionResults.length,
    // Only store wrong questions to save space (no image_url)
    questions: questionResults.map(q => ({
      question: q.question,
      options: q.options,
      answer: q.answer,
      myAnswer: q.myAnswer,
      correct: q.correct,
    })),
  }
  try {
    const prev = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
    const next = [record, ...prev].slice(0, MAX_RECORDS)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
  } catch {}
  return record
}

export default function Results() {
  const navigate = useNavigate()
  const socket = getSocket()
  const { play } = useSound()
  const { finalPlayers, isHost, stageName, questionResults, reset, betAmount } = useGameStore()
  const { name, addCoins, addExp } = usePlayerStore()

  const myResult = finalPlayers.find(p => p.name === name)
  const myRank = finalPlayers.findIndex(p => p.name === name) + 1
  const isWinner = myRank === 1
  const correctCount = questionResults.filter(q => q.correct).length
  const accuracyPct = questionResults.length > 0 ? correctCount / questionResults.length : 0
  const meetsThreshold = accuracyPct >= 0.7
  const betWinnings = isWinner && betAmount > 0 ? betAmount * 2 : 0
  const baseReward = meetsThreshold ? (isWinner ? 120 : 30) : 0
  const totalReward = baseReward + betWinnings

  useEffect(() => {
    if (finalPlayers.length === 0) { navigate('/'); return }
    play(isWinner ? 'victory' : 'defeat')

    if (totalReward > 0) addCoins(totalReward)
    if (meetsThreshold) addExp(isWinner ? 100 : 30)
    if (totalReward > 0) play('coin')

    // Save battle record
    const opponents = finalPlayers
      .filter(p => p.name !== name)
      .map(p => ({ name: p.name, score: p.score }))
    saveBattleRecord({
      myName: name,
      myScore: myResult?.score || 0,
      rank: myRank,
      totalPlayers: finalPlayers.length,
      stage: stageName,
      opponents,
      questionResults,
    })
    // Submit to leaderboard
    if (name && questionResults.length > 0) {
      const correct = questionResults.filter(q => q.correct).length
      fetch(`${BACKEND}/leaderboard/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, correct, total: questionResults.length, level: usePlayerStore.getState().level }),
      }).catch(() => {})
    }
  }, [])

  const handlePlayAgain = () => {
    if (isHost) { socket.emit('play_again'); navigate('/lobby') }
  }

  const handleBackToRoom = () => {
    navigate('/lobby')
  }

  const handleLeave = () => {
    socket.disconnect(); reset(); navigate('/')
  }

  const wrongCount = questionResults.filter(q => !q.correct).length
  const medals = ['🥇', '🥈', '🥉']

  return (
    <div className="flex flex-col min-h-dvh bg-medical-blue">
      {/* Winner banner */}
      <div className="pt-16 pb-8 flex flex-col items-center text-white">
        <div className="text-7xl mb-4 animate-pop">{isWinner ? '🏆' : '💪'}</div>
        <h1 className="text-3xl font-bold">{isWinner ? '你贏了！' : '再接再厲！'}</h1>
        <p className="opacity-70 mt-1">
          {betWinnings > 0 && `🪙 賭注 +${betWinnings} `}
          {meetsThreshold ? (isWinner ? '+120 金幣 · +100 EXP' : '+30 金幣 · +30 EXP') : '正確率未達 70%，無基本獎勵'}
        </p>
        {questionResults.length > 0 && (
          <p className="opacity-50 text-sm mt-1">
            答對 {questionResults.filter(q => q.correct).length} / {questionResults.length} 題
          </p>
        )}
      </div>

      {/* Scoreboard */}
      <div className="flex-1 bg-white rounded-t-3xl px-5 pt-6">
        <p className="text-sm font-semibold text-gray-500 mb-4 text-center">最終排名</p>
        <div className="flex flex-col gap-3">
          {finalPlayers.map((p, i) => {
            const isMe = p.name === name
            return (
              <div key={p.id}
                   className={`flex items-center gap-4 rounded-2xl px-5 py-4 shadow-sm
                     ${i === 0 ? 'bg-amber-50 border-2 border-amber-300' : 'bg-medical-ice'}`}>
                <span className="text-3xl w-8 text-center">{medals[i] || '🎖️'}</span>
                <div className="flex-1">
                  <p className={`font-bold text-lg ${isMe ? 'text-medical-blue' : 'text-medical-dark'}`}>
                    {p.avatar && <span className="mr-1">{p.avatar}</span>}
                    {p.name} {isMe && <span className="text-xs text-gray-400">(你)</span>}
                  </p>
                </div>
                <p className="text-2xl font-bold text-medical-dark">{p.score}</p>
              </div>
            )
          })}
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-3 mt-6 pb-10">
          {/* LINE Share */}
          <button
            onClick={() => {
              const correctCount = questionResults.filter(q => q.correct).length
              const pct = questionResults.length > 0 ? Math.round((correctCount / questionResults.length) * 100) : 0
              const text = `國考知識王｜${stageName} 對戰 ${isWinner ? '🏆 勝利' : '💪 第' + myRank + '名'}！正確率 ${pct}%\n一起來挑戰 👉 ${window.location.origin}`
              window.open(`https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(window.location.origin)}&text=${encodeURIComponent(text)}`, '_blank')
            }}
            className="w-full py-4 rounded-2xl font-bold text-lg active:scale-95 transition-transform flex items-center justify-center gap-2"
            style={{ background: '#06C755', color: 'white' }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M12 2C6.48 2 2 5.82 2 10.5c0 4.21 3.74 7.74 8.79 8.4.34.07.81.23.93.52.1.27.07.68.03.95l-.15.9c-.05.27-.21 1.07.94.58 1.15-.49 6.2-3.65 8.46-6.25C22.97 13.35 22 11.03 22 10.5 22 5.82 17.52 2 12 2z"/></svg>
            分享到 LINE
          </button>

          {/* Review wrong answers */}
          {wrongCount > 0 && (
            <button
              onClick={() => navigate('/review', { state: { questions: questionResults, stage: stageName } })}
              className="w-full py-4 rounded-2xl font-bold text-lg border-2 active:scale-95 transition-transform flex items-center justify-center gap-2"
              style={{ borderColor: '#EF4444', color: '#EF4444', background: '#FFF5F5' }}
            >
              📋 錯題檢討（{wrongCount} 題）
            </button>
          )}

          {/* Battle history */}
          <button
            onClick={() => navigate('/history')}
            className="w-full py-4 rounded-2xl font-bold text-lg bg-medical-ice text-medical-dark border border-gray-200 active:scale-95 transition-transform"
          >
            📊 對戰紀錄
          </button>

          {isHost ? (
            <button onClick={handlePlayAgain}
                    className="w-full bg-medical-blue text-white font-bold py-4 rounded-2xl text-lg active:scale-95 transition-transform">
              🔄 再玩一局
            </button>
          ) : (
            <button onClick={handleBackToRoom}
                    className="w-full bg-medical-blue text-white font-bold py-4 rounded-2xl text-lg active:scale-95 transition-transform">
              🚪 回房間等下一局
            </button>
          )}
          <button onClick={handleLeave}
                  className="w-full bg-medical-ice text-medical-blue font-bold py-4 rounded-2xl text-lg border-2 border-medical-blue active:scale-95 transition-transform">
            🏠 回主畫面
          </button>

          <div className="flex justify-center pt-1">
            <ShareChallengeButton
              exam={usePlayerStore.getState().exam || 'doctor1'}
              examName={getExamConfig(usePlayerStore.getState().exam || 'doctor1')?.name || '國考'}
              subjectName={stageName || null}
              correct={correctCount}
              total={questionResults.length}
              mode="pvp"
            />
          </div>

          <SmartBanner />
        </div>
      </div>
    </div>
  )
}
