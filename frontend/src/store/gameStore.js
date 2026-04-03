import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Persistent player profile
export const usePlayerStore = create(
  persist(
    (set, get) => ({
      name: '',
      avatar: '👨‍⚕️',
      coins: 500,
      level: 1,
      exp: 0,
      unlockedStages: [0, 1], // 0 = random, 1 = anatomy
      darkMode: false,
      setName: (name) => set({ name }),
      setAvatar: (avatar) => set({ avatar }),
      toggleDarkMode: () => set((s) => {
        const next = !s.darkMode
        document.documentElement.classList.toggle('dark', next)
        return { darkMode: next }
      }),
      addCoins: (n) => set((s) => ({ coins: s.coins + n })),
      spendCoins: (n) => {
        if (get().coins < n) return false
        set((s) => ({ coins: s.coins - n }))
        return true
      },
      addExp: (n) => {
        const newExp = get().exp + n
        const expPerLevel = 300
        if (newExp >= expPerLevel) {
          set((s) => ({
            exp: newExp - expPerLevel,
            level: s.level + 1,
            unlockedStages: [...new Set([...s.unlockedStages, Math.min(s.level + 1, 9)])],
          }))
        } else {
          set({ exp: newExp })
        }
      },
    }),
    { name: 'medical-quiz-player' }
  )
)

// Ephemeral game state
export const useGameStore = create((set) => ({
  roomCode: null,
  myId: null,
  isHost: false,
  phase: 'lobby', // lobby | playing | ended
  players: [],
  stage: 0,
  currentQuestion: null,
  questionIndex: 0,
  totalQuestions: 0,
  timeRemaining: 15,
  timeLimit: 15,
  myAnswer: null,
  correctAnswer: null,
  explanation: null,
  myScore: 0,
  lastTimeBonus: 0,
  finalPlayers: [],
  stageName: '',
  chatMessages: [],

  timerMode: 'auto',
  setRoom: (code, isHost, myId) => set({ roomCode: code, isHost, myId }),
  setTimerMode: (m) => set({ timerMode: m }),
  setPhase: (phase) => set({ phase }),
  setPlayers: (players) => set({ players }),
  setStage: (stage) => set({ stage }),
  setQuestion: (q, index, total, timeLimit = 15) => set({
    currentQuestion: q,
    questionIndex: index,
    totalQuestions: total,
    timeRemaining: timeLimit,
    timeLimit,
    myAnswer: null,
    correctAnswer: null,
  }),
  setTimeRemaining: (t) => set({ timeRemaining: t }),
  setMyAnswer: (a) => set({ myAnswer: a }),
  setCorrectAnswer: (a) => set({ correctAnswer: a }),
  setExplanation: (e) => set({ explanation: e }),
  setMyScore: (s, bonus = 0) => set({ myScore: s, lastTimeBonus: bonus }),
  setFinalPlayers: (p) => set({ finalPlayers: p }),
  setStageName: (n) => set({ stageName: n }),
  addChatMessage: (msg) => set(s => ({
    chatMessages: [...s.chatMessages.slice(-30), { ...msg, id: Date.now() + Math.random() }],
  })),
  questionResults: [],
  addQuestionResult: (r) => set(s => ({ questionResults: [...s.questionResults, r] })),
  reset: () => set({
    roomCode: null, myId: null, isHost: false, phase: 'lobby', players: [],
    currentQuestion: null, myAnswer: null, correctAnswer: null, explanation: null,
    myScore: 0, lastTimeBonus: 0, finalPlayers: [], timeRemaining: 15,
    chatMessages: [], questionResults: [],
  }),
}))
