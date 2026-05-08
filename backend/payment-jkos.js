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
  app.post('/payment/jkos/callback', async (req, res) => {
    try {
      const tx = req.body?.transaction
      if (!tx?.platform_order_id) return res.status(400).json({ error: 'missing transaction' })

      const { platform_order_id, status, tradeNo, final_price, debit_amount } = tx

      // Look up our order
      const { data: order, error } = await supabase
        .from('coin_orders').select('*').eq('order_id', platform_order_id).single()
      if (error || !order) {
        console.warn('JKOPay callback: unknown order', platform_order_id)
        return res.status(404).json({ error: 'order not found' })
      }

      // Idempotent — already processed
      if (order.status !== 'pending') {
        return res.status(200).send('OK')  // 街口要求 HTTP 200
      }

      // Verify by calling /inquiry (defense in depth — webhook source not auth'd by signature in body)
      let verified = null
      try { verified = await inquireJkosOrder(platform_order_id) } catch (e) {
        console.warn('inquiry verification failed', e.message)
      }

      const isPaid = (status === STATUS.SUCCESS) ||
                     (verified && verified.status === STATUS.SUCCESS)

      // Sanity check amount matches
      const amountOk = Number(final_price) === order.amount_twd
      if (isPaid && !amountOk) {
        console.error('JKOPay callback amount mismatch', platform_order_id, final_price, 'vs', order.amount_twd)
      }

      await supabase.from('coin_orders').update({
        status: (isPaid && amountOk) ? 'paid' : 'failed',
        provider_order_id: tradeNo,
        paid_at: isPaid ? new Date().toISOString() : null,
        raw_callback: req.body,
      }).eq('order_id', platform_order_id)

      // If paid, create user_coin_grant for redemption
      if (isPaid && amountOk && order.user_id) {
        await supabase.from('user_coin_grants').insert({
          user_id: order.user_id,
          coins: order.coins,
          reason: `付費充值 (${order.tier} 方案 NT$${order.amount_twd})`,
          from_name: '街口支付',
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
