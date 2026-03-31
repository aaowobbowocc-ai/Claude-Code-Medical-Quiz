import React, { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useGameStore, usePlayerStore } from '../store/gameStore'
import { getSocket } from '../hooks/useSocket'
import { useSound } from '../hooks/useSound'

export default function Results() {
  const navigate = useNavigate()
  const socket = getSocket()
  const { play } = useSound()
  const { finalPlayers, isHost, reset } = useGameStore()
  const { name, addCoins, addExp } = usePlayerStore()

  const myResult = finalPlayers.find(p => p.name === name)
  const isWinner = finalPlayers[0]?.name === name

  useEffect(() => {
    if (finalPlayers.length === 0) { navigate('/'); return }
    play(isWinner ? 'victory' : 'defeat')

    // Reward
    const reward = isWinner ? 150 : 30
    addCoins(reward)
    addExp(isWinner ? 100 : 30)
    play('coin')
  }, [])

  const handlePlayAgain = () => {
    if (isHost) {
      socket.emit('play_again')
      navigate('/lobby')
    }
  }

  const handleLeave = () => {
    socket.disconnect()
    reset()
    navigate('/')
  }

  const medals = ['🥇', '🥈', '🥉']

  return (
    <div className="flex flex-col min-h-dvh bg-medical-blue">
      {/* Winner banner */}
      <div className="pt-16 pb-8 flex flex-col items-center text-white">
        <div className="text-7xl mb-4 animate-pop">{isWinner ? '🏆' : '💪'}</div>
        <h1 className="text-3xl font-bold">{isWinner ? '你贏了！' : '再接再厲！'}</h1>
        <p className="opacity-70 mt-1">{isWinner ? '+150 金幣 · +100 EXP' : '+30 金幣 · +30 EXP'}</p>
      </div>

      {/* Scoreboard */}
      <div className="flex-1 bg-white rounded-t-3xl px-5 pt-6">
        <p className="text-sm font-semibold text-gray-500 mb-4 text-center">最終排名</p>
        <div className="flex flex-col gap-3">
          {finalPlayers.map((p, i) => {
            const isMe = p.name === name
            return (
              <div
                key={p.id}
                className={`flex items-center gap-4 rounded-2xl px-5 py-4 shadow-sm
                  ${i === 0 ? 'bg-amber-50 border-2 border-amber-300' : 'bg-medical-ice'}`}
              >
                <span className="text-3xl w-8 text-center">{medals[i] || '🎖️'}</span>
                <div className="flex-1">
                  <p className={`font-bold text-lg ${isMe ? 'text-medical-blue' : 'text-medical-dark'}`}>
                    {p.name} {isMe && <span className="text-xs text-gray-400">(你)</span>}
                  </p>
                </div>
                <p className="text-2xl font-bold text-medical-dark">{p.score}</p>
              </div>
            )
          })}
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-3 mt-8 pb-10">
          {isHost && (
            <button
              onClick={handlePlayAgain}
              className="w-full bg-medical-blue text-white font-bold py-4 rounded-2xl text-lg active:scale-95 transition-transform"
            >
              🔄 再玩一局
            </button>
          )}
          <button
            onClick={handleLeave}
            className="w-full bg-medical-ice text-medical-blue font-bold py-4 rounded-2xl text-lg border-2 border-medical-blue active:scale-95 transition-transform"
          >
            🏠 回主畫面
          </button>
        </div>
      </div>
    </div>
  )
}
