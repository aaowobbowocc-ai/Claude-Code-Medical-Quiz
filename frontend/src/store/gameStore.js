import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { supabase, ensureSession } from '../lib/supabase'

// Re-export from registry — consumers should import { getExamTypes } from gameStore or registry directly
export { getExamTypes, getExamConfig, getExamTypes as EXAM_TYPES_FN } from '../config/examRegistry'

// Map between camelCase store fields and snake_case DB columns
const FIELD_MAP = {
  name: 'name',
  avatar: 'avatar',
  coins: 'coins',
  level: 'level',
  exp: 'exp',
  unlockedStages: 'unlocked_stages',
  darkMode: 'dark_mode',
  exam: 'exam',
  lastDailyBonus: 'last_daily_bonus',
  loginStreak: 'login_streak',
  adRewardToday: 'ad_reward_today',
  lastAdWatch: 'last_ad_watch',
  lastAdDate: 'last_ad_date',
  bindRewardClaimed: 'bind_reward_claimed',
  claimedRewards: 'claimed_rewards',
}

function storeToDb(state) {
  const out = {}
  for (const [k, dbk] of Object.entries(FIELD_MAP)) {
    if (state[k] !== undefined) out[dbk] = state[k]
  }
  return out
}

function dbToStore(row) {
  const out = {}
  for (const [k, dbk] of Object.entries(FIELD_MAP)) {
    if (row[dbk] !== undefined && row[dbk] !== null) out[k] = row[dbk]
  }
  return out
}

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
      soundMuted: false,
      exam: 'doctor1',
      hydrated: false, // true after cloud sync attempted (or skipped if no supabase)
      lastHydratedUserId: null,
      hydrateFromCloud: async (force = false) => {
        if (!supabase) { set({ hydrated: true }); return }
        const user = await ensureSession()
        if (!user) { set({ hydrated: true }); return }
        // Re-entry guard: main.jsx runs this on load, App.jsx also re-runs it
        // after post-OAuth SIGNED_IN. Skip if we've already hydrated this user
        // unless caller forces it.
        if (!force && get().lastHydratedUserId === user.id) return
        set({ lastHydratedUserId: user.id })
        try {
          const { data: row, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('user_id', user.id)
            .maybeSingle()
          if (error) throw error
          // Helper: derive a usable name from Google identity (full_name → name → email prefix)
          const deriveGoogleName = () => {
            const meta = user.user_metadata || {}
            const candidate = meta.full_name || meta.name || (user.email ? user.email.split('@')[0] : '')
            return candidate ? candidate.slice(0, 12) : ''
          }
          if (row) {
            // Cloud wins — overwrite local
            set({ ...dbToStore(row), hydrated: true })
            console.log('[profile] hydrated from cloud')
            // If this row has empty name but user just linked Google, backfill from Google profile
            if (!get().name) {
              const filled = deriveGoogleName()
              if (filled) {
                set({ name: filled })
                supabase.from('profiles').update({ name: filled }).eq('user_id', user.id).then(({ error: upErr }) => {
                  if (upErr) console.warn('[profile] backfill name failed:', upErr.message)
                  else console.log('[profile] backfilled name from Google:', filled)
                })
              }
            }
          } else {
            // First time on this user — upload current local state (handles migration).
            // For brand-new Google sign-ins, pre-fill name from Google profile if local is empty.
            if (!get().name) {
              const filled = deriveGoogleName()
              if (filled) set({ name: filled })
            }
            const payload = { user_id: user.id, ...storeToDb(get()) }
            const { error: insErr } = await supabase.from('profiles').insert(payload)
            if (insErr) throw insErr
            set({ hydrated: true })
            console.log('[profile] uploaded local state to cloud')
          }
        } catch (e) {
          console.error('[profile] hydrate failed:', e.message)
          set({ hydrated: true })
        }
      },
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
      toggleSoundMuted: () => set((s) => ({ soundMuted: !s.soundMuted })),
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
      // Rewarded ad tracking
      adRewardToday: 0,
      lastAdWatch: '',
      lastAdDate: '',
      bindRewardClaimed: false,
      claimedRewards: [],
      addClaimedReward: (id) => set(s => ({ claimedRewards: [...(s.claimedRewards || []), id] })),
      claimBindReward: () => {
        if (get().bindRewardClaimed) return false
        set((s) => ({ coins: s.coins + 3000, bindRewardClaimed: true }))
        return 3000
      },
      claimAdReward: () => {
        const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })
        const s = get()
        // Reset count if new day
        const count = s.lastAdDate === today ? s.adRewardToday : 0
        if (count >= 10) return { success: false, reason: 'exhausted' }
        // Cooldown: 5 minutes
        if (s.lastAdWatch && Date.now() - new Date(s.lastAdWatch).getTime() < 5 * 60000) {
          return { success: false, reason: 'cooldown', remaining: Math.ceil((5 * 60000 - (Date.now() - new Date(s.lastAdWatch).getTime())) / 1000) }
        }
        const newCount = count + 1
        set((st) => ({
          coins: st.coins + 500,
          adRewardToday: newCount,
          lastAdWatch: new Date().toISOString(),
          lastAdDate: today,
        }))
        return { success: true, coins: 500, remaining: 10 - newCount }
      },
      getAdRewardInfo: () => {
        const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })
        const s = get()
        const count = s.lastAdDate === today ? s.adRewardToday : 0
        const cooldownLeft = s.lastAdWatch ? Math.max(0, 5 * 60000 - (Date.now() - new Date(s.lastAdWatch).getTime())) : 0
        return { watched: count, remaining: 10 - count, cooldownMs: cooldownLeft }
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
    {
      name: 'medical-quiz-player',
      // lastHydratedUserId is an in-memory re-entry guard for hydrateFromCloud;
      // don't persist it, otherwise a page reload would skip the cloud fetch.
      partialize: (state) => {
        const { lastHydratedUserId, ...rest } = state
        return rest
      },
    }
  )
)

// Debounced write-through to Supabase profiles table
let saveTimer = null
usePlayerStore.subscribe((state, prevState) => {
  if (!supabase || !state.hydrated) return
  // Skip the initial transition from not-hydrated → hydrated (cloud → local sync itself)
  if (!prevState.hydrated) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) return
      const payload = storeToDb(usePlayerStore.getState())
      payload.updated_at = new Date().toISOString()
      const { error } = await supabase.from('profiles').update(payload).eq('user_id', user.id)
      if (error) console.error('[profile] save failed:', error.message)
    } catch (e) {
      console.error('[profile] save error:', e.message)
    }
  }, 800)
})

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

// Dev console: window.dev.addCoins(10000) — only available in `npm run dev`, stripped from production build
if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.dev = {
    addCoins: (n) => { usePlayerStore.getState().addCoins(n); console.log(`+${n} coins → ${usePlayerStore.getState().coins}`) },
    setCoins: (n) => { usePlayerStore.setState({ coins: n }); console.log(`coins = ${n}`) },
    getState: () => usePlayerStore.getState(),
  }
}
