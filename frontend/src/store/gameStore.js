import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Level title tiers
const LEVEL_TITLES = [
  { min: 1,  title: '初心學徒', icon: '📖' },
  { min: 3,  title: '翻書新手', icon: '🩹' },
  { min: 6,  title: '知識行者', icon: '🔬' },
  { min: 10, title: '解題勇者', icon: '💉' },
  { min: 15, title: '學海探險家', icon: '🧭' },
  { min: 20, title: '智慧鍛造師', icon: '🔥' },
  { min: 28, title: '真理守護者', icon: '🛡️' },
  { min: 36, title: '醫道宗師', icon: '⚕️' },
  { min: 45, title: '知識霸主', icon: '🏆' },
  { min: 55, title: '傳說聖手', icon: '👑' },
]

export function getLevelTitle(level) {
  for (let i = LEVEL_TITLES.length - 1; i >= 0; i--) {
    if (level >= LEVEL_TITLES[i].min) return LEVEL_TITLES[i]
  }
  return LEVEL_TITLES[0]
}

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
        const meta = document.querySelector('meta[name="theme-color"]')
        if (meta) meta.content = next ? '#1a1714' : '#1A6B9A'
        return { darkMode: next }
      }),
      lastDailyBonus: '',
      loginStreak: 0,
      claimDailyBonus: () => {
        const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })
        if (get().lastDailyBonus === today) return false

        // Check if yesterday was claimed → streak continues
        const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })
        const wasYesterday = get().lastDailyBonus === yesterday
        const newStreak = wasYesterday ? get().loginStreak + 1 : 1

        // Streak bonus: Day2:+50, Day3-4:+100, Day5-6:+150, Day7+:+200
        const streakBonus = newStreak >= 7 ? 200 : newStreak >= 5 ? 150 : newStreak >= 3 ? 100 : newStreak >= 2 ? 50 : 0
        const totalBonus = 300 + streakBonus

        set((s) => ({ coins: s.coins + totalBonus, lastDailyBonus: today, loginStreak: newStreak }))
        return totalBonus
      },
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
  socketConnected: true,

  timerMode: 'auto',
  betAmount: 0,
  setRoom: (code, isHost, myId) => set({ roomCode: code, isHost, myId }),
  setTimerMode: (m) => set({ timerMode: m }),
  setBetAmount: (n) => set({ betAmount: n }),
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
