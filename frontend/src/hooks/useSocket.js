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
    })
  }
  return socketInstance
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
    if (!socket.connected) socket.connect()

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
          // Record per-subject accuracy
          const tag = st.currentQuestion.subject_name
          const exam = usePlayerStore.getState().exam || 'doctor1'
          if (tag) useAccuracyStore.getState().record(exam, tag, isCorrect)
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
