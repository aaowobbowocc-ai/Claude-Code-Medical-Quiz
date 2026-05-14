// 自動錯題夾：模擬考/練習/對戰答錯的題目自動加入，最多保留 200 題（FIFO）
// 跨「對戰紀錄看不到錯題」「錯題複習功能」「練習收藏錯題」3 個回饋的共用儲存

const KEY = 'wrong-questions-bank'
const MAX = 200

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') }
  catch { return [] }
}
function save(arr) {
  try { localStorage.setItem(KEY, JSON.stringify(arr)) } catch {}
}

function qKey(q) {
  return q?.id || q?.question?.slice(0, 80) || ''
}

// 加入錯題（陣列）。每題含原 question 物件 + myAnswer + addedAt。已存在的更新 addedAt 排到最前面。
export function addWrong(wrongQs) {
  if (!Array.isArray(wrongQs) || wrongQs.length === 0) return
  const now = Date.now()
  const existing = load()
  const byKey = new Map(existing.map(q => [qKey(q), q]))
  for (const wq of wrongQs) {
    const k = qKey(wq)
    if (!k) continue
    // 重複錯題：保留 + 更新 addedAt
    byKey.set(k, { ...wq, addedAt: now })
  }
  // 依 addedAt 排序新→舊，cap 在 MAX
  const next = [...byKey.values()].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, MAX)
  save(next)
}

export function getWrong() { return load() }

export function removeWrong(q) {
  const k = qKey(q); if (!k) return
  save(load().filter(x => qKey(x) !== k))
}

export function clearWrong() { save([]) }

export function wrongCount() { return load().length }

export const WRONG_BANK_MAX = MAX
