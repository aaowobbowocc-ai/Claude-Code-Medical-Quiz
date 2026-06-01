/**
 * Account management endpoints — GDPR / Play Store / Apple 政策要求。
 *
 * /api/account/delete
 *   - 要求 Bearer JWT(Supabase access_token)。
 *   - 砍掉所有跟此使用者綁定的 Supabase 資料：
 *     A. 直接刪 (個人化資料)：
 *        profiles, user_explanation_unlocks, user_frames, user_avatars,
 *        user_badges, ai_unlimited_purchases, user_coin_grants (FK CASCADE)
 *     B. 匿名化保留 (公共記錄 / 對社群仍有用)：
 *        leaderboard, mock_exam_scores, coin_orders, deprecation_reports,
 *        sponsors, feedback, reports
 *     C. 最後刪 auth.users (透過 auth.admin API)
 *   - JSON 檔型留言 (comments.json / community-notes.json) 屬輕量級 PII
 *     (僅 userId + 顯示名 + 文字)，目前不在這個 flow 處理。日後可加 sweep。
 *
 * NOTE：FK 已設 ON DELETE CASCADE / SET NULL，理論上只要刪 auth.users
 * 就會自動 cascade，但保險起見明確一張一張刪掉，避免遺漏 plain UUID 欄位。
 */
const supabase = require('./supabase')

async function getUser(req, res) {
  if (!supabase) { res.status(503).json({ error: 'auth_unavailable' }); return null }
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) { res.status(401).json({ error: 'unauthorized' }); return null }
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) { res.status(401).json({ error: 'invalid_token' }); return null }
  return user
}

function registerAccountRoutes(app) {
  app.post('/api/account/delete', async (req, res) => {
    const user = await getUser(req, res); if (!user) return
    const uid = user.id

    const errors = []

    // ── A. 個人化資料：直接刪除 ──────────────────────────────────────
    const personalTables = [
      'profiles',
      'user_explanation_unlocks',
      'user_frames',
      'user_avatars',
      'user_badges',
      'ai_unlimited_purchases',
    ]
    for (const table of personalTables) {
      const { error } = await supabase.from(table).delete().eq('user_id', uid)
      if (error && error.code !== 'PGRST116') errors.push(`${table}: ${error.message}`)
    }

    // ── B. 公共記錄：匿名化 (user_id → NULL，保留紀錄) ─────────────
    // 排行榜 / 模考分數匿名化掉但分數仍上榜（保留社群參考價值）
    const anonymizeTables = [
      'leaderboard',
      'mock_exam_scores',
      'coin_orders',
      'deprecation_reports',
      'sponsors',
      'feedback',
      'reports',
    ]
    for (const table of anonymizeTables) {
      // deprecation_reports 用 reporter_user_id, 其他都用 user_id
      const col = table === 'deprecation_reports' ? 'reporter_user_id' : 'user_id'
      const { error } = await supabase.from(table).update({ [col]: null }).eq(col, uid)
      if (error && error.code !== 'PGRST116') errors.push(`${table}: ${error.message}`)
    }

    // ── C. 最後砍 auth.users (透過 admin API) ───────────────────────
    // 會 cascade user_coin_grants / user_achievements (FK ON DELETE CASCADE)
    const { error: authErr } = await supabase.auth.admin.deleteUser(uid)
    if (authErr) errors.push(`auth.users: ${authErr.message}`)

    if (errors.length > 0) {
      console.error(`[account.delete] uid=${uid} partial errors:`, errors)
      // 即使部分失敗，auth user 通常已刪除 → 還是回 ok，由 log 追蹤殘留
      return res.status(207).json({ ok: true, partial: true, errors })
    }

    res.json({ ok: true })
  })
}

module.exports = { registerAccountRoutes }
