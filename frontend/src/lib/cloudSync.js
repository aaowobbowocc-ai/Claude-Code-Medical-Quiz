// 跨裝置同步：錯題夾 + 收藏題目（回饋 CZY「手機跟平板沒有同步」）
// 只同步「登入使用者」；訪客維持本機。用 supabase.from('user_sync')（RLS 保護、
// 跟金幣同模式），不打後端。合併策略＝聯集（union），衝突取較新的 timestamp。
import { supabase } from './supabase'
import { readAuthFromStorage } from './supabase'
import { getWrong, replaceWrong, wrongKey } from './wrongBank'
import { loadBookmarks, replaceBookmarks } from '../hooks/useBookmarks'

const WRONG_MAX = 200
const BM_MAX_PER_FOLDER = 100

function bmKey(q) { return q?.id || q?.question?.slice(0, 60) || '' }

// 錯題夾聯集：同 key 取 addedAt 較新者
function mergeWrong(localArr, cloudArr) {
  const byKey = new Map()
  for (const q of [...(cloudArr || []), ...(localArr || [])]) {
    const k = wrongKey(q); if (!k) continue
    const prev = byKey.get(k)
    if (!prev || (q.addedAt || 0) >= (prev.addedAt || 0)) byKey.set(k, q)
  }
  return [...byKey.values()].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, WRONG_MAX)
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
      wrong_bank: getWrong(),
      bookmarks: loadBookmarks(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
  } catch (e) { /* 靜默：同步失敗不影響本機使用 */ }
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
    const mergedWrong = mergeWrong(getWrong(), data?.wrong_bank)
    replaceWrong(mergedWrong)
    const mergedBm = mergeBookmarks(loadBookmarks(), data?.bookmarks)
    replaceBookmarks(mergedBm)
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
}
