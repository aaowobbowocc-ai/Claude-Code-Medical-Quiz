import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Exam types with paper/pass structure
export const EXAM_TYPES = [
  { id: 'doctor1', name: '醫師一階', short: '醫一', icon: '⚕️', totalQ: 200, passScore: 120,
    papers: [
      { id: 'paper1', name: '醫學(一)', subjects: '解剖、生理、生化、組織、胚胎', count: 100, stages: '1,2,3,4,10' },
      { id: 'paper2', name: '醫學(二)', subjects: '微免、寄生蟲、藥理、病理、公衛', count: 100, stages: '5,6,7,8,9' },
    ],
  },
  { id: 'doctor2', name: '醫師二階', short: '醫二', icon: '🏥', totalQ: 320, passScore: 192, totalPoints: 400,
    papers: [
      { id: 'paper3', name: '醫學(三)', subjects: '內科、傳染病、血液、精神、皮膚', count: 80, pointsPerQ: 1.25 },
      { id: 'paper4', name: '醫學(四)', subjects: '小兒、神經', count: 80, pointsPerQ: 1.25 },
      { id: 'paper5', name: '醫學(五)', subjects: '外科、骨科、泌尿、麻醉、眼、耳鼻喉', count: 80, pointsPerQ: 1.25 },
      { id: 'paper6', name: '醫學(六)', subjects: '婦產、復健、急診、醫療法規、倫理', count: 80, pointsPerQ: 1.25 },
    ],
  },
  { id: 'dental1', name: '牙醫一階', short: '牙一', icon: '🦷', totalQ: 160, passScore: 96, totalPoints: 200,
    papers: [
      { id: 'paper1', name: '卷一', subjects: '牙醫解剖、口腔解剖、牙體形態、胚胎組織', count: 80, pointsPerQ: 1.25 },
      { id: 'paper2', name: '卷二', subjects: '口腔病理、牙科藥理、微免、口腔生理', count: 80, pointsPerQ: 1.25 },
    ],
  },
  { id: 'dental2', name: '牙醫二階', short: '牙二', icon: '🪥', totalQ: 320, passScore: 192, totalPoints: 400,
    papers: [
      { id: 'paper1', name: '卷一', subjects: '口腔顎面外科、牙周病學', count: 80, pointsPerQ: 1.25 },
      { id: 'paper2', name: '卷二', subjects: '齒顎矯正、兒童牙科、復健牙醫、牙髓病', count: 80, pointsPerQ: 1.25 },
      { id: 'paper3', name: '卷三', subjects: '牙體復形、牙科材料、固定/活動/全口補綴', count: 80, pointsPerQ: 1.25 },
      { id: 'paper4', name: '卷四', subjects: '口腔診斷、影像、公衛、倫理、法規', count: 80, pointsPerQ: 1.25 },
    ],
  },
  { id: 'pharma1', name: '藥師一階', short: '藥一', icon: '💊', totalQ: 240, passScore: 180, totalPoints: 300,
    papers: [
      { id: 'paper1', name: '卷一', subjects: '藥理學、藥物化學', count: 80, pointsPerQ: 1.25 },
      { id: 'paper2', name: '卷二', subjects: '藥物分析、生藥學（含中藥學）', count: 80, pointsPerQ: 1.25 },
      { id: 'paper3', name: '卷三', subjects: '藥劑學、生物藥劑學', count: 80, pointsPerQ: 1.25 },
    ],
  },
  { id: 'pharma2', name: '藥師二階', short: '藥二', icon: '🧪', totalQ: 210, passScore: 180, totalPoints: 300,
    papers: [
      { id: 'paper1', name: '卷一', subjects: '調劑學、臨床藥學、治療學', count: 80, pointsPerQ: 1.25 },
      { id: 'paper2', name: '卷二', subjects: '藥物治療學', count: 80, pointsPerQ: 1.25 },
      { id: 'paper3', name: '卷三', subjects: '藥事行政與法規', count: 50, pointsPerQ: 2.0 },
    ],
  },
]

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
      exam: 'doctor1',
      setExam: (exam) => set({ exam }),
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
