/**
 * 街口支付 (JKOPay) 串接
 *
 * Flow:
 *   1. POST /payment/jkos/create-order { tier, user_id?, device_id }
 *      → 建 coin_orders row → 呼叫街口建單 → 回傳 payment_url 給 frontend
 *   2. 使用者付款（JKOPay App/網頁）
 *   3. 街口 POST 到 /payment/jkos/callback (server-to-server)
 *      → 驗 HMAC → 更新 coin_orders.status='paid' → 寫入 user_coin_grants
 *   4. 使用者開 app → 看到 grant → 認領 → 金幣入帳
 *
 * Env vars 需要 (等街口審核通過拿到再填):
 *   JKOS_API_HOST       https://uat.jkopay.com 或正式 host
 *   JKOS_API_KEY        街口給的 API key
 *   JKOS_SECRET_KEY     用來 sign HMAC 的 secret
 *   JKOS_STORE_ID       商店代號
 *   JKOS_WEBHOOK_SECRET (選用) 額外驗 webhook 用
 *   FRONTEND_BASE_URL   付款完成後 redirect 回來的 base
 */
const crypto = require('crypto')
const { randomUUID } = require('crypto')

const TIERS = {
  small:  { price: 15,  coins: 2000 },
  medium: { price: 50,  coins: 8000 },
  large:  { price: 150, coins: 28000 },
}

function sign(bodyJson, secret) {
  return crypto.createHmac('sha256', secret).update(bodyJson).digest('hex')
}

function verifyHmac(bodyJson, signature, secret) {
  const expected = sign(bodyJson, secret)
  // constant-time compare
  if (signature.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}

async function jkosCall(path, body) {
  const host = process.env.JKOS_API_HOST
  const apiKey = process.env.JKOS_API_KEY
  const secret = process.env.JKOS_SECRET_KEY
  if (!host || !apiKey || !secret) {
    throw new Error('JKOS env vars not configured')
  }
  const bodyJson = JSON.stringify(body)
  const signature = sign(bodyJson, secret)
  const resp = await fetch(`${host}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-iAPI-Key': apiKey,
      'X-iAPI-HMAC-SHA256': signature,
    },
    body: bodyJson,
  })
  const data = await resp.json().catch(() => ({}))
  return { ok: resp.ok, status: resp.status, data }
}

/**
 * 建立街口訂單
 * @param {object} order - { order_id, amount_twd, coins, valid_seconds }
 * @returns {Promise<{ jkos_order_id, payment_url }>}
 */
async function createJkosOrder({ order_id, amount_twd, valid_seconds = 900 }) {
  const storeId = process.env.JKOS_STORE_ID
  const frontendBase = process.env.FRONTEND_BASE_URL || 'https://examking.tw'
  const backendBase = process.env.BACKEND_BASE_URL || ''

  const body = {
    platform_order_id: order_id,
    currency: 'TWD',
    final_amount: amount_twd,
    valid_time: valid_seconds,
    confirm_url: `${frontendBase}/coin-shop/return?order=${order_id}`,    // 使用者付完跳回
    confirm_payment_url: `${frontendBase}/coin-shop/return?order=${order_id}`,
    result_url: `${backendBase}/payment/jkos/callback`,                    // server webhook
    result_display_url: `${frontendBase}/coin-shop/return?order=${order_id}`,
  }
  const { ok, status, data } = await jkosCall(`/platform/payment/entry/B2BMerchantOrder/${storeId}`, body)
  if (!ok || data.result_code !== '000') {
    throw new Error(`JKOPay create-order failed: ${status} ${data.result_message || JSON.stringify(data)}`)
  }
  return {
    jkos_order_id: data.result_object?.platform_tx_id || data.result_object?.order_id,
    payment_url: data.result_object?.payment_url,
  }
}

/**
 * 查詢街口訂單狀態
 */
async function inquireJkosOrder(order_id) {
  const storeId = process.env.JKOS_STORE_ID
  const body = { platform_order_id: order_id }
  const { ok, data } = await jkosCall(`/platform/payment/inquiry/B2BMerchantOrder/${storeId}`, body)
  if (!ok) throw new Error('inquiry failed')
  return data.result_object || {}
}

/**
 * 退款
 */
async function refundJkosOrder({ order_id, amount_twd, reason }) {
  const storeId = process.env.JKOS_STORE_ID
  const body = {
    platform_order_id: order_id,
    refund_amount: amount_twd,
    reason: reason || 'user request',
  }
  const { ok, data } = await jkosCall(`/platform/payment/refund/B2BMerchantOrder/${storeId}`, body)
  if (!ok || data.result_code !== '000') {
    throw new Error(`JKOPay refund failed: ${data.result_message || JSON.stringify(data)}`)
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

      // 1. Insert pending row to Supabase (audit trail before calling JKOPay)
      const { error: insertErr } = await supabase
        .from('coin_orders')
        .insert({ order_id, user_id: user_id || null, device_id, tier, amount_twd, coins, status: 'pending' })
      if (insertErr) {
        console.error('coin_orders insert failed', insertErr)
        return res.status(500).json({ error: 'db error' })
      }

      // 2. Call JKOPay
      let jkosResult
      try {
        jkosResult = await createJkosOrder({ order_id, amount_twd })
      } catch (e) {
        console.error('JKOPay createOrder failed', e.message)
        await supabase.from('coin_orders').update({ status: 'failed' }).eq('order_id', order_id)
        return res.status(502).json({ error: 'payment provider error', detail: e.message })
      }

      // 3. Update with JKOPay response
      await supabase.from('coin_orders')
        .update({ provider_order_id: jkosResult.jkos_order_id, payment_url: jkosResult.payment_url })
        .eq('order_id', order_id)

      res.json({ order_id, payment_url: jkosResult.payment_url, amount_twd, coins })
    } catch (e) {
      console.error('create-order error', e)
      res.status(500).json({ error: 'internal error' })
    }
  })

  // POST /payment/jkos/callback — 街口 server-to-server webhook
  app.post('/payment/jkos/callback', async (req, res) => {
    try {
      const rawBody = JSON.stringify(req.body)
      const signature = req.headers['x-iapi-hmac-sha256'] || req.headers['x-jkos-signature']
      const secret = process.env.JKOS_SECRET_KEY

      if (secret && signature) {
        if (!verifyHmac(rawBody, signature, secret)) {
          console.warn('JKOPay callback: invalid HMAC')
          return res.status(401).json({ error: 'bad signature' })
        }
      }

      const { platform_order_id, status, result_code } = req.body
      if (!platform_order_id) return res.status(400).json({ error: 'missing order_id' })

      // Look up our order
      const { data: order, error } = await supabase
        .from('coin_orders').select('*').eq('order_id', platform_order_id).single()
      if (error || !order) {
        console.warn('JKOPay callback: unknown order', platform_order_id)
        return res.status(404).json({ error: 'order not found' })
      }

      if (order.status !== 'pending') {
        // idempotent — already processed
        return res.json({ ok: true, duplicate: true })
      }

      const isPaid = status === 'SUCCESS' || result_code === '000'

      await supabase.from('coin_orders').update({
        status: isPaid ? 'paid' : 'failed',
        paid_at: isPaid ? new Date().toISOString() : null,
        raw_callback: req.body,
      }).eq('order_id', platform_order_id)

      // If paid, create user_coin_grant for redemption
      if (isPaid && order.user_id) {
        await supabase.from('user_coin_grants').insert({
          user_id: order.user_id,
          coins: order.coins,
          reason: `付費充值 (${order.tier} 方案 NT$${order.amount_twd})`,
          from_name: '街口支付',
        })
      }
      // For anonymous (no user_id) orders, frontend polls status and shows
      // "請登入領取金幣" — must bind device_id → user_id first.

      res.json({ ok: true })
    } catch (e) {
      console.error('callback error', e)
      res.status(500).json({ error: 'internal error' })
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
  // exported for tests / scripts
  sign,
  verifyHmac,
  createJkosOrder,
  inquireJkosOrder,
  refundJkosOrder,
}
