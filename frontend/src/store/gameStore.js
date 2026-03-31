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
      setName: (name) => set({ name }),
      setAvatar: (avatar) => set({ avatar }),
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
  isHost: false,
  phase: 'lobby', // lobby | playing | ended
  players: [],
  stage: 0,
  currentQuestion: null,
  questionIndex: 0,
  totalQuestions: 0,
  timeRemaining: 15,
  myAnswer: null,
  correctAnswer: null,
  myScore: 0,
  finalPlayers: [],
  stageName: '',

  setRoom: (code, isHost) => set({ roomCode: code, isHost }),
  setPhase: (phase) => set({ phase }),
  setPlayers: (players) => set({ players }),
  setStage: (stage) => set({ stage }),
  setQuestion: (q, index, total) => set({
    currentQuestion: q,
    questionIndex: index,
    totalQuestions: total,
    timeRemaining: 15,
    myAnswer: null,
    correctAnswer: null,
  }),
  setTimeRemaining: (t) => set({ timeRemaining: t }),
  setMyAnswer: (a) => set({ myAnswer: a }),
  setCorrectAnswer: (a) => set({ correctAnswer: a }),
  setMyScore: (s) => set({ myScore: s }),
  setFinalPlayers: (p) => set({ finalPlayers: p }),
  setStageName: (n) => set({ stageName: n }),
  reset: () => set({
    roomCode: null, isHost: false, phase: 'lobby', players: [],
    currentQuestion: null, myAnswer: null, correctAnswer: null,
    myScore: 0, finalPlayers: [], timeRemaining: 15,
  }),
}))
