// 自動錯題夾：模擬考/練習/對戰答錯的題目自動加入，最多保留 200 題（FIFO）
// 跨「對戰紀錄看不到錯題」「錯題複習功能」「練習收藏錯題」3 個回饋的共用儲存

const KEY = 'wrong-questions-bank'
const MAX = 200

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') }
  catch { return [] }
}
function save(arr, silent) {
  try { localStorage.setItem(KEY, JSON.stringify(arr)) } catch {}
  // 通知 cloudSync 有變更（跨裝置同步）；silent=從雲端合併寫回時不再回推，避免迴圈
  if (!silent) { try { window.dispatchEvent(new Event('wrongbank-changed')) } catch {} }
}

// 用雲端合併後的完整陣列覆寫本機（不觸發回推事件）
export function replaceWrong(arr) {
  if (!Array.isArray(arr)) return
  const next = [...arr].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, MAX)
  save(next, true)
}
// 供 cloudSync 合併用（穩定 key）
export const wrongKey = qKey

// Key for wrongBank dedup. Prefer `id`, but for legacy numeric IDs (used by
// audiologist/speech pre-2026-05-15 before ID regen), the underlying question
// may have shifted to a structured ID. Fall back to (exam_code, number) or
// question text so existing wrong-bank entries don't orphan after ID migration.
function qKey(q) {
  if (!q) return ''
  // Modern structured IDs (e.g. "audiologist_101070_p1_6") — trust them
  if (q.id && /^[a-z]/i.test(String(q.id))) return String(q.id)
  // Legacy numeric IDs may have been regenerated server-side → use a stable
  // composite key from exam metadata
  if (q.exam_code && q.number != null) return `${q.exam_code}_${q.subject_tag || q.subject || ''}_${q.number}`
  return q.id || q.question?.slice(0, 80) || ''
}

// 加入錯題（陣列）。每題含原 question 物件 + myAnswer + addedAt + examId（供日後 re-hydrate 取最新版）。
// 已存在的更新 addedAt 排到最前面。
export function addWrong(wrongQs, examId) {
  if (!Array.isArray(wrongQs) || wrongQs.length === 0) return
  const now = Date.now()
  const existing = load()
  const byKey = new Map(existing.map(q => [qKey(q), q]))
  for (const wq of wrongQs) {
    const k = qKey(wq)
    if (!k) continue
    // 重複錯題：保留 + 更新 addedAt；蓋上 examId 方便之後用最新題庫覆蓋舊副本
    byKey.set(k, { ...wq, examId: wq.examId || examId, addedAt: now })
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

// 用 re-hydrate 後的最新題目覆寫錯題夾（依 qKey 對應、保留 addedAt 排序），讓修正永久生效。
export function persistRehydrated(freshArr) {
  if (!Array.isArray(freshArr) || freshArr.length === 0) return
  const cur = load()
  const byKey = new Map(freshArr.map(q => [qKey(q), q]))
  const next = cur.map(old => byKey.get(qKey(old)) || old)
  save(next)
}

export function wrongCount() { return load().length }

export const WRONG_BANK_MAX = MAX
