/**
 * 排行榜段位（依名次切段）。
 * 設計：排行榜只上前 50 名，讓上榜者都有參與感 → 名次直接對段位，前 50 全部白銀以上。
 * 賽季＝每週（leaderboard 本來就 week 分區、每週重置），段位依「全站當週名次」globalRank。
 *
 *   王者 KING    第 1–3 名
 *   鑽石 DIAMOND 第 4–10 名
 *   黃金 GOLD    第 11–25 名
 *   白銀 SILVER  第 26–50 名
 *   青銅 BRONZE  榜外（51+，預設）
 */

export const TIERS = ['none', 'bronze', 'silver', 'gold', 'diamond', 'king']

export const TIER_LABEL = {
  none: '無框', bronze: '青銅', silver: '白銀', gold: '黃金', diamond: '鑽石', king: '王者',
}

/** globalRank (1-based) → tier id。傳入 null/0/undefined 視為榜外 → bronze。 */
export function tierOfRank(rank) {
  if (!rank || rank < 1) return 'bronze'
  if (rank <= 3) return 'king'
  if (rank <= 10) return 'diamond'
  if (rank <= 25) return 'gold'
  if (rank <= 50) return 'silver'
  return 'bronze'
}
