// 模擬考進度保存（多槽位）：可同時保存多份未完成的模考，各以 sessionId 區隔。
// 中斷時自動保存當前狀態，下次回來在「繼續未完成的考試」清單看到全部、可逐一接續。
// 7 天內未完成自動失效。

const KEY = 'mock-exam-sessions'        // 多槽位（陣列）
const OLD_KEY = 'mock-exam-session'     // 舊單槽位 key，讀取時自動遷移
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_SESSIONS = 12

function readAll() {
  let list = []
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    if (Array.isArray(raw)) list = raw
  } catch {}
  // 遷移舊單槽位 session（上一版只能存一份）
  try {
    const old = JSON.parse(localStorage.getItem(OLD_KEY) || 'null')
    if (old && old.pausedAt) {
      if (!old.sessionId) old.sessionId = 'legacy-' + old.pausedAt
      if (!list.some(s => s && s.sessionId === old.sessionId)) list.push(old)
      localStorage.removeItem(OLD_KEY)
      localStorage.setItem(KEY, JSON.stringify(list))
    }
  } catch {}
  return list.filter(s => s && s.pausedAt && s.sessionId &&
    Date.now() - s.pausedAt <= MAX_AGE_MS &&
    (s.questions?.length || s.atIntermission))
}

// 寫入／更新一份 session（依 sessionId upsert）
export function saveSession(state) {
  if (!state || !state.sessionId) return
  if (!state.questions?.length && !state.atIntermission) return
  try {
    let list = readAll().filter(s => s.sessionId !== state.sessionId)
    list.push({ ...state, pausedAt: Date.now() })
    list.sort((a, b) => a.pausedAt - b.pausedAt)
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_SESSIONS)))
  } catch {}
}

// 取得所有未完成 session（可選依 examType 過濾），最近暫停的排前面
export function getSessions(examType) {
  let list = readAll()
  if (examType) list = list.filter(s => s.examType === examType)
  return list.sort((a, b) => b.pausedAt - a.pausedAt)
}

// 清除指定 session；不給 sessionId 則清空全部（相容舊呼叫）
export function clearSession(sessionId) {
  try {
    if (!sessionId) { localStorage.removeItem(KEY); localStorage.removeItem(OLD_KEY); return }
    const list = readAll().filter(s => s.sessionId !== sessionId)
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {}
}

export function hasSession() {
  return readAll().length > 0
}

// 概要描述（顯示在「繼續未完成的考試」橫幅）
export function describeSession(s) {
  if (!s) return ''
  if (s.atIntermission) {
    const done = (s.paperResults || []).length
    return `完整模擬考 · 已完成 ${done} 卷 · 可續考下一卷`
  }
  const parts = []
  if (s.isFullExam) parts.push('完整模擬考')
  else parts.push(s.currentPaper?.name || '單科')
  if (s.historicalExam) parts.push(`${s.historicalExam.year}年${s.historicalExam.session}`)
  const answered = Object.keys(s.answers || {}).length
  parts.push(`第${(s.qIdx ?? 0) + 1}/${s.questions.length}題 · 已答 ${answered} 題`)
  const mm = Math.floor((s.timeLeft || 0) / 60)
  parts.push(`剩 ${mm} 分`)
  return parts.join(' · ')
}
