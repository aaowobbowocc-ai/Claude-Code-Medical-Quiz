// 跨裝置同步：錯題夾 + 收藏題目（回饋 CZY「手機跟平板沒有同步」）
// 只同步「登入使用者」；訪客維持本機。用 supabase.from('user_sync')（RLS 保護、
// 跟金幣同模式），不打後端。合併策略＝聯集（union），衝突取較新的 timestamp。
import { supabase } from './supabase'
import { readAuthFromStorage } from './supabase'
import { getWrong, replaceWrong, wrongKey, getRemoved, replaceRemoved } from './wrongBank'
import { loadBookmarks, replaceBookmarks } from '../hooks/useBookmarks'
import { useAccuracyStore } from '../store/accuracyStore'

// 練習記錄（各科正確率）快照 / 併入。欄位 accuracy 需 migration 019；未套用前
// 讀寫會拋錯 → 各自 try/catch 靜默略過，不影響錯題/收藏同步。
function accuracySnapshot() {
  const s = useAccuracyStore.getState()
  return { data: s.data, sharedData: s.sharedData, seen: s.seen, seenShared: s.seenShared }
}

const WRONG_MAX = 500   // 與 wrongBank MAX 一致
const BM_MAX_PER_FOLDER = 100

function bmKey(q) { return q?.id || q?.question?.slice(0, 60) || '' }

// 雲端 wrong_bank 欄位相容：舊格式=陣列；新格式={q:[...], rm:{key:ts}}
function unpackWrong(v) {
  if (Array.isArray(v)) return { q: v, rm: {} }
  if (v && typeof v === 'object') return { q: Array.isArray(v.q) ? v.q : [], rm: v.rm || {} }
  return { q: [], rm: {} }
}
// tombstone 聯集：同 key 取較新 removedAt
function mergeRemoved(a, b) {
  const out = { ...(a || {}) }
  for (const [k, ts] of Object.entries(b || {})) out[k] = Math.max(out[k] || 0, ts || 0)
  return out
}
// 錯題夾聯集：同 key 取 addedAt 較新者；再用 tombstone 濾掉「移除時間 >= 加入時間」的題
function mergeWrong(localArr, cloudArr, removed) {
  const byKey = new Map()
  for (const q of [...(cloudArr || []), ...(localArr || [])]) {
    const k = wrongKey(q); if (!k) continue
    const prev = byKey.get(k)
    if (!prev || (q.addedAt || 0) >= (prev.addedAt || 0)) byKey.set(k, q)
  }
  const present = [...byKey.values()].filter(q => {
    const rm = removed[wrongKey(q)] || 0
    return (q.addedAt || 0) > rm   // 加入時間比移除時間新才保留（又答錯會更新 addedAt）
  })
  return present.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, WRONG_MAX)
}

// 收藏聯集：資料夾清單聯集；每夾內同 key 取 bookmarkedAt 較新者
function mergeBookmarks(local, cloud) {
  if (!cloud || !cloud.folders) return local
  if (!local || !local.folders) return cloud
  const folders = [...new Set([...local.folders, ...cloud.folders])]
  const questions = {}
  for (const f of folders) {
    const byKey = new Map()
    for (const q of [...(cloud.questions?.[f] || []), ...(local.questions?.[f] || [])]) {
      const k = bmKey(q); if (!k) continue
      const prev = byKey.get(k)
      if (!prev || (q.bookmarkedAt || 0) >= (prev.bookmarkedAt || 0)) byKey.set(k, q)
    }
    questions[f] = [...byKey.values()]
      .sort((a, b) => (b.bookmarkedAt || 0) - (a.bookmarkedAt || 0))
      .slice(0, BM_MAX_PER_FOLDER)
  }
  return { folders, questions }
}

async function pushNow() {
  const { user_id } = readAuthFromStorage()
  if (!user_id || !supabase) return
  try {
    await supabase.from('user_sync').upsert({
      user_id,
      wrong_bank: { q: getWrong(), rm: getRemoved() },   // 含 tombstone
      bookmarks: loadBookmarks(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
  } catch (e) { /* 靜默：同步失敗不影響本機使用 */ }
  // 練習記錄：獨立 upsert（欄位未加時靜默失敗，不拖累上面）
  try {
    await supabase.from('user_sync').upsert({
      user_id, accuracy: accuracySnapshot(), updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
  } catch (e) { /* accuracy 欄位未套用 migration 019 → 略過 */ }
}

let pushTimer = null
function schedulePush() {
  const { user_id } = readAuthFromStorage()
  if (!user_id) return // 訪客不同步
  clearTimeout(pushTimer)
  pushTimer = setTimeout(pushNow, 2500)
}

// 登入時：拉雲端 → 與本機聯集 → 寫回本機 → 推合併結果上雲
export async function syncOnLogin() {
  const { user_id } = readAuthFromStorage()
  if (!user_id || !supabase) return
  try {
    const { data, error } = await supabase
      .from('user_sync').select('wrong_bank, bookmarks').eq('user_id', user_id).maybeSingle()
    if (error && error.code !== 'PGRST116') return
    const cloud = unpackWrong(data?.wrong_bank)
    const mergedRemoved = mergeRemoved(getRemoved(), cloud.rm)
    replaceRemoved(mergedRemoved)
    const mergedWrong = mergeWrong(getWrong(), cloud.q, mergedRemoved)
    replaceWrong(mergedWrong)
    const mergedBm = mergeBookmarks(loadBookmarks(), data?.bookmarks)
    replaceBookmarks(mergedBm)
    // 練習記錄：獨立拉取 + max-merge 併入本機（欄位未加時靜默略過）
    try {
      const { data: accRow } = await supabase
        .from('user_sync').select('accuracy').eq('user_id', user_id).maybeSingle()
      if (accRow?.accuracy) useAccuracyStore.getState().mergeCloud(accRow.accuracy)
    } catch (e) { /* accuracy 欄位未套用 migration 019 → 略過 */ }
    await pushNow() // 把合併結果推回，讓另一台也拿到
  } catch (e) { /* 靜默 */ }
}

// 註冊：本機錯題/收藏變更 → 防抖回推
let inited = false
export function initCloudSync() {
  if (inited) return
  inited = true
  window.addEventListener('wrongbank-changed', schedulePush)
  window.addEventListener('bookmarks-changed', schedulePush)
  // 練習記錄變更（作答後 accuracyStore 更新）→ 防抖回推
  try { useAccuracyStore.subscribe(schedulePush) } catch {}
}
