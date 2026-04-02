import { useEffect } from 'react'
import { io } from 'socket.io-client'
import { useNavigate } from 'react-router-dom'
import { useGameStore } from '../store/gameStore'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

let socketInstance = null

export function getSocket() {
  if (!socketInstance) {
    socketInstance = io(BACKEND, { autoConnect: false })
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
          st.addQuestionResult({
            question: st.currentQuestion.question,
            options: st.currentQuestion.options,
            answer: correctAnswer,
            myAnswer: st.myAnswer,
            correct: st.myAnswer === correctAnswer,
          })
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
    return () => Object.keys(handlers).forEach(ev => socket.off(ev))
  }, [navigate])

  return socket
}
