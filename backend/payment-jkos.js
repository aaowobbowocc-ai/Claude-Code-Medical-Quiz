/**
 * 街口支付 (JKOPay) 串接 — OnlinePay Entry API
 *
 * 文件：https://open-doc.jkos.com/
 * 三個 API：
 *   POST /platform/entry            — 建單，回傳 payment_url
 *   POST /platform/refund           — 退款
 *   GET  /platform/inquiry?platform_order_ids=...  — 查訂單狀態
 *
 * 認證：
 *   - Header: api-key (商店 API key)
 *   - Header: digest (HMAC-SHA256 of request body / query string, hex lowercase)
 *
 * Flow:
 *   1. POST /payment/jkos/create-order → backend 呼叫街口 /platform/entry → 回 payment_url
 *   2. 使用者在街口 App/Web 付款
 *   3. 街口 POST 到 result_url (我們的 webhook /payment/jkos/callback) → 寫 user_coin_grants
 *   4. 使用者開 app → 看到 grant → 領取
 *
 * Env vars:
 *   JKOS_API_HOST       測試: https://test-onlinepay.jkopay.app  正式: 看街口提供
 *   JKOS_API_KEY        街口提供
 *   JKOS_SECRET_KEY     街口提供（HMAC 用）
 *   JKOS_STORE_ID       街口提供
 *   FRONTEND_BASE_URL   付款完成 redirect 回此 URL
 *   BACKEND_BASE_URL    街口 webhook 打回此 URL（必須 https）
 */
const crypto = require('crypto')
const { randomUUID } = require('crypto')

const TIERS = {
  small:  { price: 15,  coins: 2000 },
  medium: { price: 50,  coins: 8000 },
  large:  { price: 150, coins: 28000 },
}

// 街口 callback 來源 IP allowlist
// 文件未提及 callback HMAC signature，安全模型靠：
//   1. 來源 IP 白名單（這份）
//   2. 商家反向 /inquiry 查證（必須成功才能放行）
//   3. amount / status 自驗
// 街口可能未來加新 IP，環境變數 JKOS_EXTRA_IPS 可加（逗號分隔）作快速補丁。
const JKOS_IP_ALLOWLIST = new Set([
  // 2026-06-03 Leona 提供正式環境 callback 來源 IPs
  '210.17.19.154',
  '210.17.19.129',
  '210.17.103.201',
  '124.108.142.123',
  '34.81.95.170',
  '35.187.144.191',
  // 2026-05-21 UAT 環境舊白名單 — 上線後若 UAT 不再用可移除
  '125.227.158.50',
  '125.227.158.49',
  '220.133.77.56',
  '59.124.107.103',
  '35.194.172.6',
  '35.244.159.28',
  '175.99.130.66',
  '175.99.130.82',
])

function getExtraIps() {
  return (process.env.JKOS_EXTRA_IPS || '').split(',').map(s => s.trim()).filter(Boolean)
}

// 取得 callback 來源 IP。重要：取「最右」XFF (LB 自己 append 的值)，不是最左。
//
// Oracle Cloud LB 收到請求時會 append 真實 TCP 源到 X-Forwarded-For 後面：
//   client → LB → Express，XFF = "<client-supplied>, <real-tcp-source-from-LB>"
//
// 攻擊者可任意 set 自己 POST 的 X-Forwarded-For（例如假成街口 IP），但 LB
// append 的那個值 (XFF 最右) 是 LB 親眼看到的 TCP 源，無法偽造。
//
// 之前用 parts[0] (最左) = 拿攻擊者自填的值 → 被任意繞過 IP allowlist。
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length) {
    const parts = xff.split(',').map(s => s.trim()).filter(Boolean)
    if (parts.length) return parts[parts.length - 1]  // rightmost = trusted LB hop
  }
  return req.ip || req.connection?.remoteAddress || ''
}

function isJkosSourceIp(ip) {
  if (!ip) return false
  // IPv4-mapped IPv6 → 去 prefix
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  return JKOS_IP_ALLOWLIST.has(normalized) || getExtraIps().includes(normalized)
}

// 訂單狀態碼（依文件）
const STATUS = {
  SUCCESS: 0,
  PAYMENT_FAIL: 100,
  NOT_PAID: 101,
  NOT_FOUND: 102,
}

function signPost(bodyJson, secret) {
  return crypto.createHmac('sha256', secret).update(bodyJson, 'utf8').digest('hex')
}
function signGet(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString, 'utf8').digest('hex')
}

function verifyHmac(input, signature, secret) {
  if (!signature) return false
  const expected = signPost(input, secret)
  if (signature.length !== expected.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch { return false }
}

async function jkosPost(path, body) {
  const host = process.env.JKOS_API_HOST
  const apiKey = process.env.JKOS_API_KEY
  const secret = process.env.JKOS_SECRET_KEY
  if (!host || !apiKey || !secret) throw new Error('JKOS env vars not configured')

  const bodyJson = JSON.stringify(body)  // compact JSON, no spaces
  const digest = signPost(bodyJson, secret)

  const resp = await fetch(`${host}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
      'digest': digest,
    },
    body: bodyJson,
  })
  const data = await resp.json().catch(() => ({}))
  return { ok: resp.ok, status: resp.status, data }
}

async function jkosGet(path, queryParams) {
  const host = process.env.JKOS_API_HOST
  const apiKey = process.env.JKOS_API_KEY
  const secret = process.env.JKOS_SECRET_KEY
  if (!host || !apiKey || !secret) throw new Error('JKOS env vars not configured')

  // Query string for sign — NOT URL encoded per doc example "platform_order_ids=test123,demo-order-001"
  const queryString = Object.entries(queryParams).map(([k, v]) => `${k}=${v}`).join('&')
  const digest = signGet(queryString, secret)

  const resp = await fetch(`${host}${path}?${queryString}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
      'digest': digest,
    },
  })
  const data = await resp.json().catch(() => ({}))
  return { ok: resp.ok, status: resp.status, data }
}

/**
 * 建單 — POST /platform/entry
 */
async function createJkosOrder({ order_id, amount_twd, valid_seconds = 1200 }) {
  const storeId = process.env.JKOS_STORE_ID
  const frontendBase = process.env.FRONTEND_BASE_URL || 'https://examking.tw'
  const backendBase = process.env.BACKEND_BASE_URL
  if (!backendBase) throw new Error('BACKEND_BASE_URL must be https')

  // valid_time: yyyy-MM-dd HH:mm:ss UTC+8
  const expireDate = new Date(Date.now() + valid_seconds * 1000 + 8 * 3600 * 1000)
  const validTime = expireDate.toISOString().replace('T', ' ').slice(0, 19)

  const body = {
    platform_order_id: order_id,
    store_id: storeId,
    currency: 'TWD',
    total_price: amount_twd,
    final_price: amount_twd,
    // 街口幣不可折抵金額。一般商品帶 0（不限制折抵）；該欄位是給「法規不可行銷
    // 商品」（如香菸）限制街口幣回饋用。⚠️ 街口驗測腳本要求務必帶 0，設錯會影響
    // 用戶街口幣回饋。
    unredeem: 0,
    result_url: `${backendBase}/payment/jkos/callback`,
    result_display_url: `${frontendBase}/coin-shop/return?order=${order_id}`,
    payment_type: 'onetime',
    escrow: false,
    valid_time: validTime,
  }
  const { ok, status, data } = await jkosPost('/platform/entry', body)
  if (!ok || data.result !== '000') {
    throw new Error(`JKOPay /entry failed: HTTP ${status} result=${data.result} msg=${data.message || JSON.stringify(data)}`)
  }
  return {
    payment_url: data.result_object?.payment_url,
    qr_img: data.result_object?.qr_img,
    qr_timeout: data.result_object?.qr_timeout,
  }
}

/**
 * 查訂單 — GET /platform/inquiry?platform_order_ids=...
 */
async function inquireJkosOrder(order_id) {
  const { ok, data } = await jkosGet('/platform/inquiry', { platform_order_ids: order_id })
  if (!ok || data.result !== '000') {
    throw new Error(`JKOPay /inquiry failed: ${data.message || JSON.stringify(data)}`)
  }
  const tx = (data.result_object?.transactions || [])[0]
  return tx || null
}

/**
 * 退款 — POST /platform/refund
 */
async function refundJkosOrder({ order_id, refund_order_id, refund_amount }) {
  const body = {
    platform_order_id: order_id,
    refund_order_id: refund_order_id || `ref_${order_id}_${Date.now()}`,
    refund_amount,
  }
  const { ok, data } = await jkosPost('/platform/refund', body)
  if (!ok || data.result !== '000') {
    throw new Error(`JKOPay /refund failed: ${data.message || JSON.stringify(data)}`)
  }
  return data.result_object || {}
}

// ────────────────────────────────────────────────────────────────────────────
// Express routes
// ────────────────────────────────────────────────────────────────────────────

function registerJkosRoutes(app, supabase) {
  // POST /payment/jkos/create-order
  app.post('/payment/jkos/create-order', async (req, res) => {
    try {
      const { tier, user_id, device_id } = req.body
      if (!TIERS[tier]) return res.status(400).json({ error: 'invalid tier' })
      const { price: amount_twd, coins } = TIERS[tier]

      const order_id = `ck_${Date.now()}_${randomUUID().slice(0, 8)}`

      // 1. Insert pending row to Supabase first (audit trail)
      const { error: insertErr } = await supabase
        .from('coin_orders')
        .insert({ order_id, user_id: user_id || null, device_id, tier, amount_twd, coins, status: 'pending' })
      if (insertErr) {
        console.error('coin_orders insert failed', insertErr)
        return res.status(500).json({ error: 'db error' })
      }

      // 2. Call JKOPay /platform/entry
      let entry
      try {
        entry = await createJkosOrder({ order_id, amount_twd })
      } catch (e) {
        console.error('JKOPay entry failed', e.message)
        await supabase.from('coin_orders').update({ status: 'failed' }).eq('order_id', order_id)
        return res.status(502).json({ error: 'payment provider error', detail: e.message })
      }

      // 3. Save payment_url
      await supabase.from('coin_orders')
        .update({ payment_url: entry.payment_url })
        .eq('order_id', order_id)

      res.json({
        order_id,
        payment_url: entry.payment_url,
        qr_img: entry.qr_img,
        amount_twd,
        coins,
      })
    } catch (e) {
      console.error('create-order error', e)
      res.status(500).json({ error: 'internal error' })
    }
  })

  // POST /payment/jkos/confirm — optional confirm_url callback (街口付款前 server-to-server 確認)
  // 我們不用 confirm_url 機制（暫不實作），如有需要再加
  // app.post('/payment/jkos/confirm', ...)

  // POST /payment/jkos/callback — result_url webhook (街口付款後通知)
  //
  // 安全模型（依街口 open-doc.jkos.com 文件，callback 無 HMAC signature header）：
  //   1. 來源 IP allowlist（JKOS_IP_ALLOWLIST）— 拒絕非街口 IP 的 POST
  //   2. /inquiry 反向查證必須回 SUCCESS — 失敗 / 5xx 一律拒絕（不信 body）
  //   3. callback body 與 inquiry 的 final_price 都要等於 order.amount_twd
  //
  // 街口 retry 規則：失敗會重送，每 2^n 秒間隔最多 12 次（~2 小時）。
  // 所以 inquiry 暫時 5xx 時拒絕 callback、回非 200 是安全的，街口會 retry。
  app.post('/payment/jkos/callback', async (req, res) => {
    try {
      // ── 防護 1：來源 IP allowlist ────────────────────────────
      const clientIp = getClientIp(req)
      if (!isJkosSourceIp(clientIp)) {
        console.warn('JKOPay callback rejected: source IP not in allowlist', clientIp)
        return res.status(403).json({ error: 'forbidden' })
      }

      const tx = req.body?.transaction
      if (!tx?.platform_order_id) return res.status(400).json({ error: 'missing transaction' })

      const { platform_order_id, status, tradeNo, final_price } = tx

      // Look up our order
      const { data: order, error } = await supabase
        .from('coin_orders').select('*').eq('order_id', platform_order_id).single()
      if (error || !order) {
        console.warn('JKOPay callback: unknown order', platform_order_id)
        return res.status(404).json({ error: 'order not found' })
      }

      // Idempotent — already processed
      if (order.status !== 'pending') {
        return res.status(200).send('OK')
      }

      // ── 防護 2：/inquiry 反向查證必須成功 ───────────────────
      let verified
      try {
        verified = await inquireJkosOrder(platform_order_id)
      } catch (e) {
        // /inquiry 5xx → 拒絕，回 503 讓街口 retry（不信 body）
        console.error('JKOPay callback rejected: inquiry failed', platform_order_id, e.message)
        return res.status(503).json({ error: 'inquiry unavailable, retry later' })
      }
      if (!verified || verified.status !== STATUS.SUCCESS) {
        // /inquiry 回非 SUCCESS → 訂單本身有問題（未付款、退款中、不存在）
        console.warn('JKOPay callback: inquiry says not paid', platform_order_id, verified?.status)
        await supabase.from('coin_orders').update({
          status: 'failed',
          provider_order_id: tradeNo,
          raw_callback: req.body,
        }).eq('order_id', platform_order_id)
        return res.status(200).send('OK')
      }

      // ── 防護 3：金額一致（body + inquiry 都要等於原始訂單）──
      const bodyAmountOk = Number(final_price) === order.amount_twd
      const inquiryAmountOk = Number(verified.final_price) === order.amount_twd
      if (!bodyAmountOk || !inquiryAmountOk) {
        console.error('JKOPay callback rejected: amount mismatch',
          platform_order_id, 'order=', order.amount_twd,
          'body=', final_price, 'inquiry=', verified.final_price)
        await supabase.from('coin_orders').update({
          status: 'failed',
          provider_order_id: tradeNo,
          raw_callback: req.body,
        }).eq('order_id', platform_order_id)
        return res.status(200).send('OK')
      }

      // 三道防護全過 → 入帳
      // Optimistic concurrency guard: 只在 status='pending' 時 update 並回傳 row。
      // 街口 callback 可能 retry 重送 (2^n 秒最多 12 次)，第一次成功後 status
      // 已是 paid，第二次此 update 影響 0 rows，下面入帳邏輯就 skip。
      const { data: claimedRows, error: claimErr } = await supabase
        .from('coin_orders')
        .update({
          status: 'paid',
          provider_order_id: tradeNo,
          paid_at: new Date().toISOString(),
          raw_callback: req.body,
        })
        .eq('order_id', platform_order_id)
        .eq('status', 'pending')
        .select('order_id, user_id, coins, tier, amount_twd')

      if (claimErr) {
        console.error('coin_orders update failed', claimErr)
        return res.status(500).json({ error: 'db error' })
      }
      if (!claimedRows || claimedRows.length === 0) {
        // 已被 retry 的另一個 callback 領走，安全 noop
        return res.status(200).send('OK')
      }
      const claimed = claimedRows[0]

      // 自動入帳：直接加 profiles.coins (匿名訂單 user_id 為空就 skip)。
      // grant 同時 insert 作 audit 紀錄，但 claimed_at 立即填好 = 不會觸發
      // CoinGrantModal 的「未領取」popup，使用者體驗就是「付完馬上有錢」。
      if (claimed.user_id) {
        const { data: profile } = await supabase
          .from('profiles').select('coins').eq('user_id', claimed.user_id).single()
        const newCoins = (profile?.coins || 0) + claimed.coins
        await supabase.from('profiles')
          .update({ coins: newCoins })
          .eq('user_id', claimed.user_id)
        await supabase.from('user_coin_grants').insert({
          user_id: claimed.user_id,
          coins: claimed.coins,
          reason: `付費充值 (${claimed.tier} 方案 NT$${claimed.amount_twd})`,
          from_name: '街口支付',
          claimed_at: new Date().toISOString(),
        })
      }

      // 街口要求 HTTP 200 視為收到
      res.status(200).send('OK')
    } catch (e) {
      console.error('callback error', e)
      // Still return 200 to avoid retry storm — but log for investigation
      res.status(200).send('OK')
    }
  })

  // GET /payment/jkos/status/:order_id — frontend polls after payment
  app.get('/payment/jkos/status/:order_id', async (req, res) => {
    try {
      const { data: order } = await supabase
        .from('coin_orders')
        .select('status, coins, amount_twd, tier, paid_at')
        .eq('order_id', req.params.order_id)
        .single()
      if (!order) return res.status(404).json({ error: 'order not found' })
      res.json(order)
    } catch (e) {
      res.status(500).json({ error: 'internal error' })
    }
  })
}

module.exports = {
  registerJkosRoutes,
  TIERS,
  STATUS,
  signPost,
  signGet,
  verifyHmac,
  createJkosOrder,
  inquireJkosOrder,
  refundJkosOrder,
}
