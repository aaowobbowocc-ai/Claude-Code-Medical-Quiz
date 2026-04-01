import React, { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useGameStore, usePlayerStore } from '../store/gameStore'
import { getSocket } from '../hooks/useSocket'
import { useSound } from '../hooks/useSound'

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
  const { finalPlayers, isHost, stageName, questionResults, reset } = useGameStore()
  const { name, addCoins, addExp } = usePlayerStore()

  const myResult = finalPlayers.find(p => p.name === name)
  const myRank = finalPlayers.findIndex(p => p.name === name) + 1
  const isWinner = myRank === 1

  useEffect(() => {
    if (finalPlayers.length === 0) { navigate('/'); return }
    play(isWinner ? 'victory' : 'defeat')
    const reward = isWinner ? 150 : 30
    addCoins(reward)
    addExp(isWinner ? 100 : 30)
    play('coin')

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
  }, [])

  const handlePlayAgain = () => {
    if (isHost) { socket.emit('play_again'); navigate('/lobby') }
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
        <p className="opacity-70 mt-1">{isWinner ? '+150 金幣 · +100 EXP' : '+30 金幣 · +30 EXP'}</p>
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

          {isHost && (
            <button onClick={handlePlayAgain}
                    className="w-full bg-medical-blue text-white font-bold py-4 rounded-2xl text-lg active:scale-95 transition-transform">
              🔄 再玩一局
            </button>
          )}
          <button onClick={handleLeave}
                  className="w-full bg-medical-ice text-medical-blue font-bold py-4 rounded-2xl text-lg border-2 border-medical-blue active:scale-95 transition-transform">
            🏠 回主畫面
          </button>
        </div>
      </div>
    </div>
  )
}
