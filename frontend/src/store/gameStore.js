import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { supabase, ensureSession, readAuthFromStorage } from '../lib/supabase'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

// Server-side delta write — prevents localStorage manipulation from inflating coins.
// Fire-and-forget: local state updates immediately for UI responsiveness.
async function persistCoinDelta(delta) {
  if (!supabase) return
  try {
    // 不用 await supabase.auth.getSession() — 在 Capacitor Native (App) 會 hang/回空。
    // 改 sync 讀 localStorage。詳見 [[feedback_supabase_no_getsession]] 5/29 Shop 載入卡死事件。
    const { token } = readAuthFromStorage()
    if (!token) return
    fetch(`${BACKEND}/api/coins/delta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ delta }),
    }).catch(() => {})
  } catch {}
}

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
  equippedBadgeId: 'equipped_badge_id',
  equippedFrameId: 'equipped_frame_id',
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
      equippedBadgeId: null,
      equippedFrameId: null,
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
            // Cloud wins — overwrite local.
            // ⚠️ dbToStore 會「跳過 null 欄位」，所以 name/avatar 一定要在這裡明確設定，
            // 否則雲端帳號這兩欄為 null 時，綁定前的匿名 name/avatar 會「漏」下來，
            // 還會被下面 800ms 的 write-through 寫回雲端（造成綁定後名字/頭像沒換）。
            const cloudName = row.name || deriveGoogleName() || ''
            set({
              ...dbToStore(row),
              name: cloudName,
              avatar: row.avatar || '👨‍⚕️',
              hydrated: true,
            })
            console.log('[profile] hydrated from cloud')
            // 雲端 name 原本為空、但有 Google 身分名 → 補寫回雲端讓它持久化
            if (!row.name && cloudName) {
              supabase.from('profiles').update({ name: cloudName }).eq('user_id', user.id).then(({ error: upErr }) => {
                if (upErr) console.warn('[profile] backfill name failed:', upErr.message)
                else console.log('[profile] backfilled name from Google:', cloudName)
              })
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
      // Daily login bonus — server-authoritative (backend owns last_daily_bonus
      // date check + streak). Async; callers must await.
      claimDailyBonus: async () => {
        const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })
        if (get().lastDailyBonus === today) return false
        // sync 讀，避免 Capacitor Native getSession hang
        const { token } = readAuthFromStorage()
        if (!token) return false
        try {
          const res = await fetch(`${BACKEND}/api/rewards/daily`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}` },
          })
          const json = await res.json()
          // 只有後端確實回傳餘額(成功發放 or 伺服器確認今天已領)才標記今天已領。
          // 若回錯誤(401/500/無 coins 欄位)就「不要」標記，讓使用者下次能重領，
          // 否則一次暫時性失敗會害使用者整天領不到金幣。
          if (typeof json.coins === 'number') {
            set({ coins: json.coins, lastDailyBonus: today, loginStreak: json.streak || get().loginStreak })
          }
          return json.claimed ? (json.reward || 0) : false
        } catch { return false }
      },
      addCoins: (n) => {
        set((s) => ({ coins: s.coins + n }))
        persistCoinDelta(n)
      },
      spendCoins: (n) => {
        if (get().coins < n) return false
        set((s) => ({ coins: s.coins - n }))
        persistCoinDelta(-n)
        return true
      },
      // Rewarded ad tracking
      adRewardToday: 0,
      lastAdWatch: '',
      lastAdDate: '',
      bindRewardClaimed: false,
      claimedRewards: [],
      addClaimedReward: (id) => set(s => ({ claimedRewards: [...(s.claimedRewards || []), id] })),
      // Bind reward — server-authoritative (backend owns bind_reward_claimed
      // flag, atomically grants 3000 coins). Async; callers must await.
      claimBindReward: async () => {
        if (get().bindRewardClaimed) return false
        // sync 讀，避免 Capacitor Native getSession hang
        const { token } = readAuthFromStorage()
        if (!token) return false
        try {
          const res = await fetch(`${BACKEND}/api/rewards/bind`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}` },
          })
          const json = await res.json()
          // Sync server state regardless of claimed/already-claimed
          if (typeof json.coins === 'number') set({ coins: json.coins, bindRewardClaimed: true })
          else set({ bindRewardClaimed: true })
          return json.claimed ? (json.reward || 3000) : false
        } catch { return false }
      },
      // Ad reward — server owns daily counter. Async; callers must await.
      claimAdReward: async () => {
        // sync 讀，避免 Capacitor Native getSession hang。這條路線是 6/3 v1.0.1
        // 看廣告領金幣後一直顯示「廣告載入失敗」的真因 — getSession 回空 token。
        const { token, user_id } = readAuthFromStorage()
        if (!token) return { success: false, reason: 'no_auth' }
        // 確保雲端有 profile 列再領獎。原生 App hydrate 失敗的訪客（getSession hang）
        // 可能還沒同步出 profile，後端領獎 .single() 找不到列會回失敗 → 影片白看。
        // ignoreDuplicates upsert：缺列才用本機狀態補建（保住既有金幣）、已有列完全
        // 不動，避免 cloud 覆蓋本機。詳見 [[feedback_supabase_no_getsession]]。
        if (user_id) {
          try {
            await supabase.from('profiles').upsert(
              { user_id, ...storeToDb(get()) },
              { onConflict: 'user_id', ignoreDuplicates: true }
            )
          } catch (e) { console.warn('[ad] ensure profile failed:', e?.message) }
        }
        const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })
        try {
          const res = await fetch(`${BACKEND}/api/rewards/ad`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}` },
          })
          const json = await res.json()
          if (json.claimed) {
            set({ coins: json.coins, adRewardToday: json.count, lastAdDate: today, lastAdWatch: new Date().toISOString() })
            return { success: true, coins: 300, remaining: 10 - json.count }
          }
          if (json.reason === 'exhausted') {
            set({ adRewardToday: json.count, lastAdDate: today })
            return { success: false, reason: 'exhausted' }
          }
          return { success: false, reason: json.reason || 'error' }
        } catch { return { success: false, reason: 'network' } }
      },
      getAdRewardInfo: () => {
        const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })
        const s = get()
        const count = s.lastAdDate === today ? s.adRewardToday : 0
        return { watched: count, remaining: 10 - count, cooldownMs: 0 }
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
      // sync 讀，避免 Capacitor Native getSession hang
      const { user_id } = readAuthFromStorage()
      if (!user_id) return
      const user = { id: user_id }
      const payload = storeToDb(usePlayerStore.getState())
      delete payload.coins  // never overwrite coins via write-through; use persistCoinDelta instead
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
    setBadge: (id) => { usePlayerStore.setState({ equippedBadgeId: id }); console.log(`badge = ${id}`) },
    setFrame: (id) => { usePlayerStore.setState({ equippedFrameId: id }); console.log(`frame = ${id}`) },
    getState: () => usePlayerStore.getState(),
  }
}
