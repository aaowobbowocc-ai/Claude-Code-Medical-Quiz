/**
 * Monetization endpoints — Phase 1：邊框 / AI 無限 / 頭像 / 感謝榜
 *
 * 全部 endpoint 由 FEATURE_<NAME> env flag 控制；flag OFF → 回 503。
 * 上線時設 FEATURE_FRAMES=1 / FEATURE_AI_UNLIMITED=1 / 等 即啟用。
 */
const supabase = require('./supabase')

const FLAGS = {
  FRAMES:        process.env.FEATURE_FRAMES === '1',
  AI_UNLIMITED:  process.env.FEATURE_AI_UNLIMITED === '1',
  AVATARS:       process.env.FEATURE_AVATARS === '1',
  SPONSORS:      process.env.FEATURE_SPONSORS === '1',
}

// ─── auth helper ───────────────────────────────────────────────────────
async function getUser(req, res) {
  if (!supabase) { res.status(503).json({ error: 'auth_unavailable' }); return null }
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) { res.status(401).json({ error: 'unauthorized' }); return null }
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) { res.status(401).json({ error: 'invalid_token' }); return null }
  return user
}

function gateFlag(flag, res) {
  if (!flag) { res.status(503).json({ error: 'feature_disabled' }); return false }
  return true
}

// ═════════════════════════════════════════════════════════════════════
// 邊框 / Frames
// ═════════════════════════════════════════════════════════════════════

// GET /api/profile — 回登入使用者的 profile (避免讓 frontend 直接打 supabase)
function registerProfileRoute(app) {
  app.get('/api/profile', async (req, res) => {
    const user = await getUser(req, res); if (!user) return
    const { data, error } = await supabase
      .from('profiles')
      .select('user_id, name, avatar, coins, level, equipped_frame_id, ai_unlimited_until')
      .eq('user_id', user.id).single()
    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
  })
}

function registerFrameRoutes(app) {
  // GET /api/frames/catalog — 所有可購買邊框
  app.get('/api/frames/catalog', async (req, res) => {
    if (!gateFlag(FLAGS.FRAMES, res)) return
    const { data, error } = await supabase
      .from('frames').select('*').order('sort_order')
    if (error) return res.status(500).json({ error: error.message })
    res.json({ frames: data || [] })
  })

  // GET /api/user/frames — 使用者擁有的邊框
  app.get('/api/user/frames', async (req, res) => {
    if (!gateFlag(FLAGS.FRAMES, res)) return
    const user = await getUser(req, res); if (!user) return
    const { data, error } = await supabase
      .from('user_frames').select('frame_id, acquired_at, source').eq('user_id', user.id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ owned: data || [] })
  })

  // POST /api/user/frames/purchase — 用金幣買
  app.post('/api/user/frames/purchase', async (req, res) => {
    if (!gateFlag(FLAGS.FRAMES, res)) return
    const user = await getUser(req, res); if (!user) return
    const { frame_id } = req.body || {}
    if (!frame_id) return res.status(400).json({ error: 'missing_frame_id' })

    const [{ data: frame }, { data: profile }, { data: owned }] = await Promise.all([
      supabase.from('frames').select('*').eq('id', frame_id).single(),
      supabase.from('profiles').select('coins').eq('user_id', user.id).single(),
      supabase.from('user_frames').select('frame_id').eq('user_id', user.id).eq('frame_id', frame_id).maybeSingle(),
    ])
    if (!frame) return res.status(404).json({ error: 'frame_not_found' })
    if (!profile) return res.status(404).json({ error: 'profile_not_found' })
    if (owned) return res.status(409).json({ error: 'already_owned' })
    if (!frame.price_coins) return res.status(400).json({ error: 'not_purchasable_by_coins' })
    if ((profile.coins || 0) < frame.price_coins) return res.status(402).json({ error: 'insufficient_coins', need: frame.price_coins, have: profile.coins || 0 })

    // 扣金幣 + insert ownership（沒有 transaction，但 idempotency check 已有）
    // BUG-7 fix: profiles.coins is nullable — .eq('coins', 0) does NOT match NULL
    // in PostgreSQL. Use .is(null) when coins is null, .eq(N) otherwise.
    // .select() returns updated rows; empty array = race condition (coins changed).
    let updateQ = supabase.from('profiles')
      .update({ coins: (profile.coins || 0) - frame.price_coins })
      .eq('user_id', user.id)
    updateQ = profile.coins == null ? updateQ.is('coins', null) : updateQ.eq('coins', profile.coins)
    const { data: d1, error: e1 } = await updateQ.select('user_id')
    if (e1) return res.status(500).json({ error: e1.message })
    if (!d1 || d1.length === 0) return res.status(409).json({ error: 'coins_changed', hint: 'retry' })
    const { error: e2 } = await supabase.from('user_frames').insert({
      user_id: user.id, frame_id, source: 'coins',
    })
    if (e2) {
      // rollback：補回金幣
      await supabase.from('profiles').update({ coins: profile.coins }).eq('user_id', user.id)
      return res.status(500).json({ error: e2.message })
    }
    res.json({ ok: true, coins_left: (profile.coins || 0) - frame.price_coins })
  })

  // POST /api/user/frames/equip — 裝備邊框
  app.post('/api/user/frames/equip', async (req, res) => {
    if (!gateFlag(FLAGS.FRAMES, res)) return
    const user = await getUser(req, res); if (!user) return
    const { frame_id } = req.body || {}
    if (!frame_id || frame_id === 'none') {
      await supabase.from('profiles').update({ equipped_frame_id: null }).eq('user_id', user.id)
      return res.json({ ok: true, equipped: null })
    }
    const { data: owned } = await supabase.from('user_frames')
      .select('frame_id').eq('user_id', user.id).eq('frame_id', frame_id).maybeSingle()
    if (!owned) return res.status(403).json({ error: 'not_owned' })
    await supabase.from('profiles').update({ equipped_frame_id: frame_id }).eq('user_id', user.id)
    res.json({ ok: true, equipped: frame_id })
  })
}

// ═════════════════════════════════════════════════════════════════════
// AI 解說無限包 / AI Unlimited
// ═════════════════════════════════════════════════════════════════════

const AI_UNLIMITED_PACKAGES = {
  '7day':     { days: 7,    ntd: 50,  label: '7 天無限' },
  '30day':    { days: 30,   ntd: 150, label: '30 天無限' },
  'lifetime': { days: null, ntd: 199, label: '永久無限' },
}

// helper：給 ai.js 用，檢查使用者是否有效無限包
async function hasActiveAiUnlimited(userId) {
  if (!supabase || !userId) return false
  const { data } = await supabase.from('profiles')
    .select('ai_unlimited_until').eq('user_id', userId).single()
  if (!data?.ai_unlimited_until) return false
  return new Date(data.ai_unlimited_until) > new Date()
}

function registerAiUnlimitedRoutes(app) {
  // GET /api/ai-unlimited/status — 我目前的無限包狀態
  app.get('/api/ai-unlimited/status', async (req, res) => {
    if (!gateFlag(FLAGS.AI_UNLIMITED, res)) return
    const user = await getUser(req, res); if (!user) return
    const { data } = await supabase.from('profiles')
      .select('ai_unlimited_until').eq('user_id', user.id).single()
    const active = data?.ai_unlimited_until && new Date(data.ai_unlimited_until) > new Date()
    res.json({
      active: !!active,
      until: data?.ai_unlimited_until || null,
      packages: AI_UNLIMITED_PACKAGES,
    })
  })

  // POST /api/ai-unlimited/purchase — placeholder（金流串完才正式）
  app.post('/api/ai-unlimited/purchase', async (req, res) => {
    if (!gateFlag(FLAGS.AI_UNLIMITED, res)) return
    // 目前金流還沒接 → 一律 503
    return res.status(503).json({ error: 'payment_not_configured', message: '請走綠界贊助，金幣/無限包會手動發放' })
  })
}

// ═════════════════════════════════════════════════════════════════════
// 頭像 / Avatars
// ═════════════════════════════════════════════════════════════════════

function registerAvatarRoutes(app) {
  app.get('/api/avatars/catalog', async (req, res) => {
    if (!gateFlag(FLAGS.AVATARS, res)) return
    const { data, error } = await supabase
      .from('avatars').select('*').order('sort_order')
    if (error) return res.status(500).json({ error: error.message })
    res.json({ avatars: data || [] })
  })

  app.get('/api/user/avatars', async (req, res) => {
    if (!gateFlag(FLAGS.AVATARS, res)) return
    const user = await getUser(req, res); if (!user) return
    const { data, error } = await supabase
      .from('user_avatars').select('avatar_id, acquired_at, source').eq('user_id', user.id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ owned: data || [] })
  })

  app.post('/api/user/avatars/purchase', async (req, res) => {
    if (!gateFlag(FLAGS.AVATARS, res)) return
    const user = await getUser(req, res); if (!user) return
    const { avatar_id } = req.body || {}
    if (!avatar_id) return res.status(400).json({ error: 'missing_avatar_id' })
    const [{ data: avatar }, { data: profile }, { data: owned }] = await Promise.all([
      supabase.from('avatars').select('*').eq('id', avatar_id).single(),
      supabase.from('profiles').select('coins').eq('user_id', user.id).single(),
      supabase.from('user_avatars').select('avatar_id').eq('user_id', user.id).eq('avatar_id', avatar_id).maybeSingle(),
    ])
    if (!avatar) return res.status(404).json({ error: 'avatar_not_found' })
    if (!profile) return res.status(404).json({ error: 'profile_not_found' })
    if (owned) return res.status(409).json({ error: 'already_owned' })
    if (!avatar.price_coins) return res.status(400).json({ error: 'not_purchasable_by_coins' })
    if ((profile.coins || 0) < avatar.price_coins) {
      return res.status(402).json({ error: 'insufficient_coins', need: avatar.price_coins, have: profile.coins || 0 })
    }
    // 扣金幣 + insert ownership — 與 frames purchase 同模式做 rollback
    // BUG-7 fix: handle NULL coins for optimistic concurrency (see frame purchase)
    let updateQ = supabase.from('profiles')
      .update({ coins: (profile.coins || 0) - avatar.price_coins })
      .eq('user_id', user.id)
    updateQ = profile.coins == null ? updateQ.is('coins', null) : updateQ.eq('coins', profile.coins)
    const { data: d1, error: e1 } = await updateQ.select('user_id')
    if (e1) return res.status(500).json({ error: e1.message })
    if (!d1 || d1.length === 0) return res.status(409).json({ error: 'coins_changed', hint: 'retry' })
    const { error: e2 } = await supabase.from('user_avatars').insert({
      user_id: user.id, avatar_id, source: 'coins',
    })
    if (e2) {
      await supabase.from('profiles').update({ coins: profile.coins }).eq('user_id', user.id)
      return res.status(500).json({ error: e2.message })
    }
    res.json({ ok: true, coins_left: (profile.coins || 0) - avatar.price_coins })
  })

  app.post('/api/user/avatars/equip', async (req, res) => {
    if (!gateFlag(FLAGS.AVATARS, res)) return
    const user = await getUser(req, res); if (!user) return
    const { avatar_id } = req.body || {}
    if (!avatar_id) return res.status(400).json({ error: 'missing_avatar_id' })
    // 確認擁有
    const { data: owned } = await supabase.from('user_avatars')
      .select('avatar_id').eq('user_id', user.id).eq('avatar_id', avatar_id).maybeSingle()
    if (!owned && !avatar_id.startsWith('default_')) {
      return res.status(403).json({ error: 'not_owned' })
    }
    // 取 avatar 的 icon 字串，存進 profiles.avatar
    const { data: avatar } = await supabase.from('avatars').select('icon').eq('id', avatar_id).single()
    if (!avatar) return res.status(404).json({ error: 'avatar_not_found' })
    await supabase.from('profiles').update({ avatar: avatar.icon }).eq('user_id', user.id)
    res.json({ ok: true, avatar: avatar.icon })
  })
}

// ═════════════════════════════════════════════════════════════════════
// 感謝榜 / Sponsors
// ═════════════════════════════════════════════════════════════════════

function registerSponsorRoutes(app) {
  // 公開：任何人可看（不需登入）
  app.get('/api/sponsors', async (req, res) => {
    if (!gateFlag(FLAGS.SPONSORS, res)) return
    const { data, error } = await supabase
      .from('sponsors')
      .select('display_name, amount_ntd, tier, anonymous, message, created_at')
      .order('amount_ntd', { ascending: false })
      .limit(200)
    if (error) return res.status(500).json({ error: error.message })
    // 匿名 → 顯示「匿名贊助」
    const list = (data || []).map(s => ({
      ...s,
      display_name: s.anonymous ? '匿名贊助' : s.display_name,
    }))
    res.json({ sponsors: list })
  })
}

// ═════════════════════════════════════════════════════════════════════
// Export
// ═════════════════════════════════════════════════════════════════════

function registerMonetizationRoutes(app) {
  registerProfileRoute(app)
  registerFrameRoutes(app)
  registerAiUnlimitedRoutes(app)
  registerAvatarRoutes(app)
  registerSponsorRoutes(app)

  console.log(`[monetization] flags:`, FLAGS)
}

module.exports = { registerMonetizationRoutes, hasActiveAiUnlimited, FLAGS }
