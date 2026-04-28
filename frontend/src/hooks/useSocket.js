import { useEffect } from 'react'
import { io } from 'socket.io-client'
import { useNavigate } from 'react-router-dom'
import { useGameStore, usePlayerStore } from '../store/gameStore'
import { useAccuracyStore } from '../store/accuracyStore'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

let socketInstance = null

export function getSocket() {
  if (!socketInstance) {
    socketInstance = io(BACKEND, {
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      // websocket-only — avoids long-polling XHR pings that prevent backend sleep
      transports: ['websocket'],
    })
  }
  return socketInstance
}

// Lazy connect: only connect when explicitly needed (PvP create/join/rejoin).
// Prevents every page-load from waking up backend (saves Render free instance hours).
export function ensureSocketConnected() {
  const s = getSocket()
  if (!s.connected) s.connect()
  return s
}

// Explicit disconnect when leaving PvP context — lets backend sleep sooner.
export function disconnectSocket() {
  if (socketInstance && socketInstance.connected) socketInstance.disconnect()
}

export function useSocket() {
  const navigate = useNavigate()
  const socket = getSocket()
  const {
    setRoom, setPhase, setPlayers, setStage, setTimerMode,
    setQuestion, setTimeRemaining, setMyAnswer,
    setCorrectAnswer, setExplanation, setMyScore, setFinalPlayers, setStageName, addChatMessage,
  } = useGameStore()

  useEffect(() => {
    // Don't auto-connect — only register handlers. Explicit connect happens
    // when user creates/joins a PvP room (Home.jsx) or has a pending share link (App.jsx).
    const handlers = {
      room_created: ({ code }) => {
        setRoom(code, true, socket.id)
        navigate('/lobby')
      },
      room_joined: ({ code }) => {
        setRoom(code, false, socket.id)
        navigate('/lobby')
      },
      room_state: ({ players, stage, phase, timerMode }) => {
        setPlayers(players)
        setStage(stage)
        setPhase(phase)
        if (timerMode) setTimerMode(timerMode)
        // Host pressed 再玩一局 → server reset phase to 'lobby'. Pull
        // everyone (including non-hosts stuck on /results) back to /lobby.
        if (phase === 'lobby') {
          const here = window.location.pathname
          if (here === '/results' || here === '/game') navigate('/lobby')
        }
      },
      game_starting: ({ stageName }) => {
        setStageName(stageName)
        navigate('/game')
      },
      question: ({ index, total, question, options, image_url, roc_year, session, subject_name, number, timeLimit }) => {
        setQuestion({ question, options, image_url, roc_year, session, subject_name, number }, index, total, timeLimit)
        setMyAnswer(null)
        setCorrectAnswer(null)
      },
      tick: ({ remaining }) => setTimeRemaining(remaining),
      answer_result: ({ score, timeBonus }) => {
        setMyScore(score, timeBonus || 0)
      },
      chat_msg: (msg) => addChatMessage(msg),
      reveal: ({ correctAnswer, explanation, players }) => {
        const st = useGameStore.getState()
        if (st.currentQuestion) {
          const isCorrect = st.myAnswer === correctAnswer
          st.addQuestionResult({
            question: st.currentQuestion.question,
            options: st.currentQuestion.options,
            answer: correctAnswer,
            myAnswer: st.myAnswer,
            correct: isCorrect,
          })
          // Record per-subject accuracy (shared-bank questions route to cross-exam pool)
          const cq = st.currentQuestion
          const tag = cq.subject_tag || cq.subject_tags?.[0] || cq.subject_name
          const exam = usePlayerStore.getState().exam || 'doctor1'
          const bankId = cq.isSharedBank ? cq.sourceBankId : null
          if (tag && !cq.is_deprecated) useAccuracyStore.getState().record(exam, tag, isCorrect, bankId)
        }
        setCorrectAnswer(correctAnswer)
        setExplanation(explanation || null)
        setPlayers(players)
      },
      game_over: ({ players }) => {
        setFinalPlayers(players)
        setPhase('ended')
        navigate('/results')
      },
      host_changed: () => {},
      player_left: ({ message }) => alert(message),
      kicked_from_room: ({ reason }) => {
        useGameStore.getState().reset()
        navigate('/')
        alert(reason || '你已被房主請出房間')
      },
      error: ({ message }) => console.warn('[socket error]', message),
    }

    Object.entries(handlers).forEach(([ev, fn]) => socket.on(ev, fn))

    // Connection status tracking + auto-rejoin on reconnect
    const onDisconnect = () => useGameStore.setState({ socketConnected: false })
    const onConnect = () => {
      useGameStore.setState({ socketConnected: true })
      // Auto-rejoin room after reconnect
      const { roomCode } = useGameStore.getState()
      if (roomCode) {
        const { name, avatar } = usePlayerStore.getState()
        socket.emit('rejoin_room', { code: roomCode, playerName: name, playerAvatar: avatar })
      }
    }
    socket.on('disconnect', onDisconnect)
    socket.on('connect', onConnect)

    return () => {
      Object.keys(handlers).forEach(ev => socket.off(ev))
      socket.off('disconnect', onDisconnect)
      socket.off('connect', onConnect)
    }
  }, [navigate])

  return socket
}
