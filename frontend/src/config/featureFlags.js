/**
 * Feature flags — 預設全部 OFF，正式上線前一鍵切開。
 *
 * 開發中的功能加 flag 後 → 完整 code 可以 commit 但使用者看不到。
 *
 * 切換方式：
 *   - 開發時：直接改下方 const 為 true
 *   - 部署時：Vercel/Render 設 env var VITE_FEATURE_<NAME>=1
 *
 * 規則：絕對不要 leak 流程（即使 UI 隱藏，後端 API 也要拒絕未啟用 flag 的請求）
 */

const envFlag = (name) => {
  try {
    return import.meta.env[`VITE_FEATURE_${name}`] === '1' || import.meta.env[`VITE_FEATURE_${name}`] === 'true'
  } catch {
    return false
  }
}

// ── Phase 1 monetization features（2026-05-28 開發中）────────────────────
// 邊框系統：排行榜/個人 profile 顯示自訂邊框
export const FEATURE_FRAMES = envFlag('FRAMES')

// AI 解說無限包：付費後一段時間內 /explain 不扣金幣
export const FEATURE_AI_UNLIMITED = envFlag('AI_UNLIMITED')

// 頭像系統：金幣 / 付費解鎖更多頭像
export const FEATURE_AVATARS = envFlag('AVATARS')

// 感謝榜：贊助者永久展示頁面
export const FEATURE_SPONSORS = envFlag('SPONSORS')

// 徽章系統：金幣解鎖、單一裝備、顯示在 Leaderboard/PvP 名字旁
export const FEATURE_BADGES = envFlag('BADGES')

// 段位框：排行榜整列依當週名次套華麗段位框（王者/鑽石/黃金/白銀）+ 精緻名次獎牌
// Phase 1＝即時段位視覺（依 globalRank）；預設 OFF，VITE_FEATURE_RANK_FRAMES=1 開啟
export const FEATURE_RANK_FRAMES = envFlag('RANK_FRAMES')
