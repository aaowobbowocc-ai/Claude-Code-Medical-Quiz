import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useGameStore } from '../store/gameStore'
import { getSocket } from '../hooks/useSocket'
import { useSound } from '../hooks/useSound'

const OPTION_COLORS = {
  A: { base: 'bg-blue-50  border-blue-300  text-blue-800',  active: 'bg-blue-500  border-blue-500  text-white' },
  B: { base: 'bg-green-50 border-green-300 text-green-800', active: 'bg-green-500 border-green-500 text-white' },
  C: { base: 'bg-amber-50 border-amber-300 text-amber-800', active: 'bg-amber-500 border-amber-500 text-white' },
  D: { base: 'bg-rose-50  border-rose-300  text-rose-800',  active: 'bg-rose-500  border-rose-500  text-white' },
}

const QUICK_PHRASES = ['加油！💪', '哈哈哈😂', '這題好難😅', '我知道了！', '太強了！', '運氣好🍀']
const STICKERS = ['🔥','⚡','🎯','👍','😭','🤯','🏆','💀','🥲','🎉']

/* ── Chat bubble overlay ─────────────────────────────────────── */
function ChatBubbles({ messages, myId }) {
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden z-20">
      {messages.map(msg => {
        const isMe = msg.fromId === myId
        return (
          <ChatBubble key={msg.id} msg={msg} isMe={isMe} />
        )
      })}
    </div>
  )
}

function ChatBubble({ msg, isMe }) {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const t = setTimeout(() => setVisible(false), 2800)
    return () => clearTimeout(t)
  }, [])
  if (!visible) return null
  return (
    <div className={`absolute top-16 animate-fadeout ${isMe ? 'left-4' : 'right-4'}`}>
      <div className={`px-3 py-2 rounded-2xl shadow-lg text-sm font-medium max-w-[120px] text-center
        ${msg.type === 'sticker' ? 'text-3xl bg-transparent shadow-none' : 'bg-white border border-gray-200 text-gray-800'}`}>
        {msg.content}
      </div>
      <div className={`text-center text-xs mt-0.5 opacity-50 ${isMe ? '' : 'text-right'}`}>
        {msg.name}
      </div>
    </div>
  )
}

/* ── Player avatar card ──────────────────────────────────────── */
function PlayerCard({ player, isMe, flip, maxScore, hasAnswered, isReveal, correct }) {
  const pct = maxScore > 0 ? Math.min((player.score / maxScore) * 100, 100) : 0
  const answerIcon = isReveal && hasAnswered
    ? (correct ? '✅' : '❌')
    : isReveal && !hasAnswered ? '⏱️' : null

  return (
    <div className={`flex flex-col items-center gap-1 ${flip ? 'items-end' : 'items-start'}`}
         style={{ width: '42%' }}>
      {/* Avatar + answer icon */}
      <div className="relative">
        <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-3xl shadow-md border-2
          ${isMe ? 'border-blue-400 bg-blue-900/40' : 'border-rose-400 bg-rose-900/40'}`}>
          {player.avatar || '👨‍⚕️'}
        </div>
        {answerIcon && (
          <span className="absolute -top-1 -right-1 text-base">{answerIcon}</span>
        )}
        {hasAnswered && !isReveal && (
          <span className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-green-400 border-2 border-white" />
        )}
      </div>
      {/* Name */}
      <p className="text-white text-xs font-semibold truncate max-w-[100px]">{player.name}</p>
      {/* Score */}
      <p className="text-white font-bold text-base leading-none">{player.score}</p>
      {/* Score bar */}
      <div className={`w-full h-2 rounded-full bg-white/20 overflow-hidden ${flip ? 'scale-x-[-1]' : ''}`}>
        <div
          className={`h-full rounded-full transition-all duration-700 ${isMe ? 'bg-blue-400' : 'bg-rose-400'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

/* ── Chat panel ──────────────────────────────────────────────── */
function ChatPanel({ onSend, onClose }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div className="w-full max-w-[430px] bg-white rounded-t-3xl px-4 pb-10 pt-3 shadow-2xl"
           onClick={e => e.stopPropagation()}>
        <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-4" />
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">快速對話</p>
        <div className="flex flex-wrap gap-2 mb-4">
          {QUICK_PHRASES.map(p => (
            <button key={p}
                    onClick={() => { onSend('phrase', p); onClose() }}
                    className="px-3.5 py-2 bg-blue-50 border border-blue-200 text-blue-700 rounded-2xl text-sm font-medium active:scale-95 transition-transform">
              {p}
            </button>
          ))}
        </div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">貼圖</p>
        <div className="flex gap-2 flex-wrap">
          {STICKERS.map(s => (
            <button key={s}
                    onClick={() => { onSend('sticker', s); onClose() }}
                    className="w-12 h-12 rounded-2xl bg-gray-50 border border-gray-200 text-2xl flex items-center justify-center active:scale-90 transition-transform">
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ── Quit confirm sheet ──────────────────────────────────────── */
function QuitSheet({ onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={onCancel}>
      <div className="w-full max-w-[430px] bg-white rounded-t-3xl px-5 pb-10 pt-4 shadow-2xl"
           onClick={e => e.stopPropagation()}>
        <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-5" />
        <p className="text-lg font-bold text-medical-dark text-center mb-1">確定要退出對戰？</p>
        <p className="text-sm text-gray-500 text-center mb-6">退出後將計為本場落敗，無法繼續。</p>
        <button
          onClick={onConfirm}
          className="w-full py-4 rounded-2xl font-bold text-white text-base mb-3 active:scale-95 transition-transform"
          style={{ background: 'linear-gradient(135deg, #EF4444, #DC2626)' }}>
          退出對戰
        </button>
        <button
          onClick={onCancel}
          className="w-full py-4 rounded-2xl font-bold text-gray-600 text-base bg-gray-100 active:scale-95 transition-transform">
          繼續作答
        </button>
      </div>
    </div>
  )
}

/* ── Main Game page ──────────────────────────────────────────── */
export default function Game() {
  const navigate = useNavigate()
  const socket = getSocket()
  const { play } = useSound()
  const [chatOpen, setChatOpen] = useState(false)
  const [quitOpen, setQuitOpen] = useState(false)

  const handleQuit = () => {
    socket.disconnect()
    navigate('/')
  }

  const {
    currentQuestion, questionIndex, totalQuestions,
    timeRemaining, timeLimit, myAnswer, correctAnswer, explanation, myScore,
    players, phase, roomCode, stageName, myId, chatMessages, lastTimeBonus,
  } = useGameStore()

  useEffect(() => {
    if (!roomCode) navigate('/')
  }, [roomCode])

  // Tick sound
  useEffect(() => {
    if (timeRemaining <= 5 && timeRemaining > 0 && !myAnswer) play('countdown')
    if (timeRemaining === 0) play('time_up')
  }, [timeRemaining])

  // Reveal sound
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

  const handleSendChat = (type, content) => {
    socket.emit('send_chat', { type, content })
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

  const progress = (questionIndex / totalQuestions) * 100
  const timePercent = (timeRemaining / timeLimit) * 100
  const timeColor = timeRemaining > timeLimit * 0.5
    ? 'bg-emerald-400'
    : timeRemaining > timeLimit * 0.25
      ? 'bg-amber-400'
      : 'bg-rose-500'

  // Identify me vs opponents
  const resolvedMyId = myId || socket.id
  const me = players.find(p => p.id === resolvedMyId) || players[0]
  const opponents = players.filter(p => p.id !== resolvedMyId)
  const opponent = opponents[0]  // primary opponent (2-player)
  const extraPlayers = opponents.slice(1)

  // Max possible score: totalQuestions * 150
  const maxScore = totalQuestions * 150

  // Recent chat messages (last 6)
  const recentChat = chatMessages.slice(-6)

  return (
    <div className="flex flex-col min-h-dvh bg-white">

      {/* ── Top: gradient header with avatars ─────────────────── */}
      <div className="relative grad-header">

        {/* Chat bubbles overlay */}
        <ChatBubbles messages={recentChat} myId={resolvedMyId} />

        {/* Question progress */}
        <div className="flex items-center justify-between px-5 pt-12 pb-2">
          <button
            onClick={() => setQuitOpen(true)}
            className="text-white/50 text-sm active:opacity-70 transition-opacity"
          >
            ✕ 退出
          </button>
          <span className="text-white font-bold text-sm">{questionIndex + 1} / {totalQuestions}</span>
          <div className="w-20 h-1.5 bg-white/20 rounded-full overflow-hidden">
            <div className="h-full bg-white/70 rounded-full transition-all duration-300"
                 style={{ width: `${progress}%` }} />
          </div>
        </div>

        {/* Player vs layout */}
        <div className="flex items-start justify-between px-5 pt-2 pb-4">
          {/* Me (left) */}
          {me && (
            <PlayerCard
              player={me}
              isMe={true}
              flip={false}
              maxScore={maxScore}
              hasAnswered={!!myAnswer}
              isReveal={!!correctAnswer}
              correct={myAnswer === correctAnswer}
            />
          )}

          {/* VS center */}
          <div className="flex flex-col items-center justify-center gap-1 pt-3">
            <span className="text-white/40 text-xs font-bold tracking-widest">VS</span>
            {players.length > 2 && (
              <div className="flex flex-col gap-0.5">
                {extraPlayers.map(p => (
                  <div key={p.id}
                       className="text-[10px] text-white/50 text-center truncate max-w-[60px]">
                    {p.avatar} {p.score}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Opponent (right) */}
          {opponent ? (
            <PlayerCard
              player={opponent}
              isMe={false}
              flip={true}
              maxScore={maxScore}
              hasAnswered={opponent.answered}
              isReveal={!!correctAnswer}
              correct={opponent.lastAnswer === correctAnswer}
            />
          ) : (
            <div style={{ width: '42%' }} className="flex flex-col items-end gap-1 opacity-30">
              <div className="w-14 h-14 rounded-2xl border-2 border-dashed border-white/30 flex items-center justify-center text-2xl">
                ?
              </div>
              <p className="text-white text-xs">等待對手</p>
            </div>
          )}
        </div>

        {/* Timer bar */}
        <div className="h-2 bg-black/20">
          <div
            className={`h-full transition-all duration-1000 ease-linear ${timeColor} ${timeRemaining <= 5 ? 'animate-pulse' : ''}`}
            style={{ width: `${timePercent}%` }}
          />
        </div>
      </div>

      {/* Timer number */}
      <div className="text-center text-3xl font-bold text-medical-dark py-2 leading-none">
        {timeRemaining}
      </div>

      {/* ── Question + options ────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-5 pb-24">
        <div className="bg-medical-ice rounded-2xl p-4 mb-4">
          {(currentQuestion.roc_year || currentQuestion.subject_name) && (
            <p className="text-xs text-gray-400 font-mono mb-2">
              {currentQuestion.roc_year && currentQuestion.session
                ? `${currentQuestion.roc_year}(${currentQuestion.session === '第一次' ? '一' : '二'})-${currentQuestion.number}`
                : currentQuestion.number ? `#${currentQuestion.number}` : ''}
              {currentQuestion.subject_name ? `　${currentQuestion.subject_name}` : ''}
            </p>
          )}
          <p className="text-medical-dark font-medium text-base leading-relaxed">
            {currentQuestion.question}
          </p>
          {currentQuestion.image_url && (
            <img src={currentQuestion.image_url} alt="題目圖片"
                 className="mt-3 w-full rounded-xl border border-blue-100 object-contain max-h-48" />
          )}
        </div>

        <div className="flex flex-col gap-3">
          {Object.entries(currentQuestion.options).map(([letter, text]) => {
            const isSelected = myAnswer === letter
            const isCorrect  = correctAnswer === letter
            const isWrong    = myAnswer === letter && correctAnswer && correctAnswer !== letter

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
                <span className="text-sm leading-snug flex-1">{text}</span>
                {isCorrect && correctAnswer && <span className="ml-auto shrink-0">✓</span>}
                {isWrong && <span className="ml-auto shrink-0">✗</span>}
              </button>
            )
          })}
        </div>

        {/* Answer feedback */}
        {correctAnswer && (
          <div className={`mt-4 rounded-2xl p-4 text-center font-bold text-lg
            ${myAnswer === correctAnswer ? 'bg-medical-light text-medical-success' : 'bg-red-50 text-medical-danger'}`}>
            {myAnswer === correctAnswer
              ? <>✅ 答對了！{lastTimeBonus > 0 && <span className="text-base font-normal ml-2 text-emerald-600">+{100 + lastTimeBonus}分（含速度加成+{lastTimeBonus}）</span>}</>
              : `❌ 正確答案是 ${correctAnswer}`}
            <p className="text-sm font-normal opacity-70 mt-1">下一題即將到來...</p>
          </div>
        )}

        {!myAnswer && !correctAnswer && (
          <p className="text-center text-xs text-gray-400 mt-4">點選選項作答</p>
        )}
      </div>

      {/* ── Floating chat button ──────────────────────────────── */}
      <button
        onClick={() => setChatOpen(true)}
        className="fixed bottom-6 right-5 w-14 h-14 rounded-full shadow-xl flex items-center justify-center text-2xl active:scale-90 transition-transform z-30 grad-cta"
      >
        💬
      </button>

      {chatOpen && (
        <ChatPanel onSend={handleSendChat} onClose={() => setChatOpen(false)} />
      )}

      {quitOpen && (
        <QuitSheet onConfirm={handleQuit} onCancel={() => setQuitOpen(false)} />
      )}
    </div>
  )
}
