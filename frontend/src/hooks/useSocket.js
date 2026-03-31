import { useEffect, useRef } from 'react'
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
    setRoom, setPhase, setPlayers, setStage,
    setQuestion, setTimeRemaining, setMyAnswer,
    setCorrectAnswer, setMyScore, setFinalPlayers, setStageName, reset,
  } = useGameStore()

  useEffect(() => {
    if (!socket.connected) socket.connect()

    const handlers = {
      room_created: ({ code }) => {
        setRoom(code, true)
        navigate('/lobby')
      },
      room_joined: ({ code }) => {
        setRoom(code, false)
        navigate('/lobby')
      },
      room_state: ({ players, stage, phase, hostId }) => {
        setPlayers(players)
        setStage(stage)
        setPhase(phase)
      },
      game_starting: ({ stageName, questionCount }) => {
        setStageName(stageName)
        navigate('/game')
      },
      question: ({ index, total, question, options, timeLimit }) => {
        setQuestion({ question, options }, index, total)
        setMyAnswer(null)
        setCorrectAnswer(null)
      },
      tick: ({ remaining }) => setTimeRemaining(remaining),
      answer_result: ({ correct, score }) => {
        setMyScore(score)
      },
      reveal: ({ correctAnswer, players }) => {
        setCorrectAnswer(correctAnswer)
        setPlayers(players)
      },
      game_over: ({ players }) => {
        setFinalPlayers(players)
        setPhase('ended')
        navigate('/results')
      },
      host_changed: () => {},
      player_left: ({ message }) => {
        alert(message)
      },
      error: ({ message }) => {
        // Handled per-page via direct socket.on listeners
        console.warn('[socket error]', message)
      },
    }

    Object.entries(handlers).forEach(([ev, fn]) => socket.on(ev, fn))
    return () => Object.keys(handlers).forEach(ev => socket.off(ev))
  }, [navigate])

  return socket
}
