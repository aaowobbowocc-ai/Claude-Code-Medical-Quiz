// 模擬考進度保存：中斷時自動保存當前狀態，下次回來可繼續寫。
// 同一時間只有一場進行中（單一 session），7 天內未完成自動失效。

const KEY = 'mock-exam-session'
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000  // 7 天

export function saveSession(state) {
  if (!state || !state.questions?.length) return
  try {
    const payload = {
      ...state,
      pausedAt: Date.now(),
    }
    localStorage.setItem(KEY, JSON.stringify(payload))
  } catch {}
}

export function getSession() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const s = JSON.parse(raw)
    // 過期或無效 → 清除
    if (!s || !s.pausedAt || Date.now() - s.pausedAt > MAX_AGE_MS) {
      localStorage.removeItem(KEY)
      return null
    }
    if (!s.questions?.length || !s.currentPaper) {
      localStorage.removeItem(KEY)
      return null
    }
    return s
  } catch { return null }
}

export function clearSession() {
  try { localStorage.removeItem(KEY) } catch {}
}

export function hasSession() {
  return !!getSession()
}

// 概要描述（顯示在「繼續未完成的考試」橫幅）
export function describeSession(s) {
  if (!s) return ''
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
