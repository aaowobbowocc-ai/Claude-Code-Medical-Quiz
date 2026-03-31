import React, { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useGameStore, usePlayerStore } from '../store/gameStore'
import { getSocket } from '../hooks/useSocket'
import { useSound } from '../hooks/useSound'

const OPTION_COLORS = {
  A: { base: 'bg-blue-50  border-blue-300  text-blue-800',  active: 'bg-blue-500  border-blue-500  text-white' },
  B: { base: 'bg-green-50 border-green-300 text-green-800', active: 'bg-green-500 border-green-500 text-white' },
  C: { base: 'bg-amber-50 border-amber-300 text-amber-800', active: 'bg-amber-500 border-amber-500 text-white' },
  D: { base: 'bg-rose-50  border-rose-300  text-rose-800',  active: 'bg-rose-500  border-rose-500  text-white' },
}

export default function Game() {
  const navigate = useNavigate()
  const socket = getSocket()
  const { play } = useSound()
  const tickRef = useRef(false)

  const {
    currentQuestion, questionIndex, totalQuestions,
    timeRemaining, timeLimit, myAnswer, correctAnswer, myScore,
    players, phase, roomCode, stageName,
  } = useGameStore()

  useEffect(() => {
    if (!roomCode) navigate('/')
  }, [roomCode])

  // Tick sound when time is low (last 5s)
  useEffect(() => {
    if (timeRemaining <= 5 && timeRemaining > 0 && !myAnswer) {
      play('countdown')
    }
    if (timeRemaining === 0) {
      play('time_up')
    }
  }, [timeRemaining])

  // Sound on reveal
  useEffect(() => {
    if (correctAnswer && myAnswer) {
      if (myAnswer === correctAnswer) play('correct')
      else play('wrong')
    }
  }, [correctAnswer])

  const handleAnswer = (letter) => {
    if (myAnswer || correctAnswer) return
    useGameStore.getState().setMyAnswer(letter)
    socket.emit('submit_answer', { answer: letter })
  }

  if (!currentQuestion) {
    return (
      <div className="flex flex-col min-h-dvh bg-medical-blue items-center justify-center text-white gap-4">
        <div className="text-5xl animate-bounce">⚕️</div>
        <p className="text-xl font-bold">準備開始...</p>
        <p className="text-sm opacity-70">{stageName}</p>
      </div>
    )
  }

  const progress = ((questionIndex) / totalQuestions) * 100
  const timePercent = (timeRemaining / timeLimit) * 100
  const timeColor = timeRemaining > timeLimit * 0.5 ? 'bg-medical-success' : timeRemaining > timeLimit * 0.25 ? 'bg-amber-400' : 'bg-medical-danger'

  // Sort players by score
  const sorted = [...players].sort((a, b) => b.score - a.score)

  return (
    <div className="flex flex-col min-h-dvh bg-white">
      {/* Top bar: scores */}
      <div className="bg-medical-blue px-4 pt-10 pb-4">
        {/* Question progress */}
        <div className="flex items-center justify-between text-white text-xs mb-2">
          <span>{stageName}</span>
          <span className="font-bold">{questionIndex + 1} / {totalQuestions}</span>
        </div>
        <div className="w-full h-1.5 bg-white/20 rounded-full mb-4">
          <div className="h-full bg-white rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
        </div>

        {/* Player scores */}
        <div className="flex gap-2">
          {sorted.map((p, i) => {
            const answerTag = correctAnswer && p.lastAnswer
              ? (p.lastAnswer === correctAnswer
                  ? <span className="text-xs font-bold text-green-300 ml-1">{p.lastAnswer} ✓</span>
                  : <span className="text-xs font-bold text-red-300 ml-1">{p.lastAnswer} ✗</span>)
              : correctAnswer && !p.lastAnswer
                ? <span className="text-xs text-white/40 ml-1">—</span>
                : null
            return (
              <div key={p.id} className={`flex-1 rounded-xl px-3 py-2 ${i === 0 ? 'bg-white/20' : 'bg-white/10'}`}>
                <p className="text-white/60 text-xs truncate flex items-center gap-0.5">
                  {p.name}{answerTag}
                </p>
                <p className="text-white font-bold text-lg leading-tight">{p.score}</p>
              </div>
            )
          })}
        </div>
      </div>

      {/* Timer bar */}
      <div className="h-2.5 bg-gray-100">
        <div
          className={`h-full transition-all duration-1000 ease-linear ${timeColor} ${timeRemaining <= 5 ? 'animate-pulse' : ''}`}
          style={{ width: `${timePercent}%` }}
        />
      </div>
      <div className="text-center text-3xl font-bold text-medical-dark py-2 leading-none">
        {timeRemaining}
      </div>

      {/* Question */}
      <div className="flex-1 overflow-y-auto px-5 pb-4">
        <div className="bg-medical-ice rounded-2xl p-4 mb-4">
          <p className="text-medical-dark font-medium text-base leading-relaxed">
            {currentQuestion.question}
          </p>
        </div>

        {/* Options */}
        <div className="flex flex-col gap-3">
          {Object.entries(currentQuestion.options).map(([letter, text]) => {
            const isSelected = myAnswer === letter
            const isCorrect = correctAnswer === letter
            const isWrong = myAnswer === letter && correctAnswer && correctAnswer !== letter

            let cls = `border-2 rounded-2xl px-4 py-3.5 text-left transition-all active:scale-95 flex items-start gap-3`
            if (isCorrect && correctAnswer) {
              cls += ' bg-medical-success border-medical-success text-white animate-pop'
            } else if (isWrong) {
              cls += ' bg-medical-danger border-medical-danger text-white animate-shake'
            } else if (isSelected) {
              cls += ` ${OPTION_COLORS[letter].active}`
            } else {
              cls += ` ${OPTION_COLORS[letter].base} ${!myAnswer && !correctAnswer ? 'cursor-pointer' : 'opacity-60'}`
            }

            return (
              <button key={letter} className={cls} onClick={() => handleAnswer(letter)}>
                <span className="font-bold text-lg w-6 shrink-0 leading-tight">{letter}</span>
                <span className="text-sm leading-snug">{text}</span>
                {isCorrect && correctAnswer && <span className="ml-auto shrink-0">✓</span>}
                {isWrong && <span className="ml-auto shrink-0">✗</span>}
              </button>
            )
          })}
        </div>

        {/* Answer feedback */}
        {correctAnswer && (
          <div className={`mt-4 rounded-2xl p-4 text-center font-bold text-lg
            ${myAnswer === correctAnswer ? 'bg-medical-light text-medical-success' : 'bg-red-50 text-medical-danger'}`}
          >
            {myAnswer === correctAnswer ? '✅ 答對了！' : `❌ 正確答案是 ${correctAnswer}`}
            <p className="text-sm font-normal opacity-70 mt-1">下一題即將到來...</p>
          </div>
        )}

        {!myAnswer && !correctAnswer && (
          <p className="text-center text-xs text-gray-400 mt-4">點選選項作答</p>
        )}
      </div>
    </div>
  )
}
