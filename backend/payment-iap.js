/**
 * App 內購 (IAP) 發幣 — RevenueCat Webhook
 *
 * 為什麼走 RevenueCat：Apple StoreKit + Google Play Billing 的「收據驗證」各一套、
 * 很容易出包（盜刷/漏發），RevenueCat 幫我們統一驗證，購買成功後打這個 webhook，
 * 我們只負責「對照 product_id → 幣數 → idempotent 寫進 profiles.coins」。
 *
 * ⚠️ 平台政策：App 內消費的數位幣「只能」用 IAP（Apple/Google），不能用街口/信用卡。
 * 這支端點就是 App 端 IAP 的入帳來源；街口那套 (payment-jkos.js) 維持 Web only。
 *
 * Flow:
 *   1. App 端 Purchases.configure({ appUserID: <supabase user_id> })
 *   2. 使用者買消耗型幣包 → RevenueCat 驗證 Apple/Google 收據
 *   3. RevenueCat POST 到 /payment/iap/revenuecat  (本端點)
 *   4. 我們對照 product_id → coins，idempotent 加到 profiles.coins
 *
 * 安全模型：
 *   1. RevenueCat webhook 可設一個 Authorization header 值（共享密鑰），我們比對。
 *   2. transaction_id 去重（coin_orders.order_id = iap_<transaction_id>）→ 重送不重複發。
 *
 * Env vars:
 *   REVENUECAT_WEBHOOK_AUTH   在 RevenueCat 後台 webhook 設定的 Authorization 值（自訂密鑰）
 *   IAP_PRODUCT_COINS         (可選) JSON 覆寫 product_id→coins，如 {"coins_35000":35000}
 */

// product_id → 幣數。預設對照；可用 env IAP_PRODUCT_COINS(JSON) 覆寫/擴充。
// product_id 要跟 App Store Connect / Play Console / RevenueCat 建的商品一致。
const DEFAULT_PRODUCT_COINS = {
  coins_2500: 2500,
  coins_10000: 10000,
  coins_35000: 35000,
};

function getProductCoins() {
  let map = { ...DEFAULT_PRODUCT_COINS };
  if (process.env.IAP_PRODUCT_COINS) {
    try { map = { ...map, ...JSON.parse(process.env.IAP_PRODUCT_COINS) }; }
    catch (e) { console.warn('[iap] IAP_PRODUCT_COINS parse failed:', e.message); }
  }
  return map;
}

// 這些事件型別代表「一次性/消耗型購買成功」→ 該發幣。
// NON_RENEWING_PURCHASE = 消耗型/非續訂（金幣就是這種）。
// INITIAL_PURCHASE 理論上是訂閱首購，這裡一併容忍（若日後有非消耗型商品）。
const CREDIT_EVENTS = new Set(['NON_RENEWING_PURCHASE', 'INITIAL_PURCHASE']);
// 退款/退單事件 → 只記錄，不自動扣（幣可能已花掉，扣了會變負數；留人工處理）。
const REFUND_EVENTS = new Set(['CANCELLATION', 'REFUND', 'SUBSCRIPTION_PAUSED']);

function storeToProvider(store) {
  if (store === 'APP_STORE' || store === 'MAC_APP_STORE') return 'apple';
  if (store === 'PLAY_STORE') return 'google';
  return (store || 'iap').toLowerCase();
}

function registerIapRoutes(app, supabase) {
  // POST /payment/iap/revenuecat — RevenueCat webhook
  app.post('/payment/iap/revenuecat', async (req, res) => {
    try {
      // ── 防護 1：Authorization 共享密鑰 ─────────────────────────
      const expected = process.env.REVENUECAT_WEBHOOK_AUTH;
      if (expected && req.headers.authorization !== expected) {
        console.warn('[iap] webhook rejected: bad Authorization');
        return res.status(401).json({ error: 'unauthorized' });
      }

      const event = req.body?.event;
      if (!event || !event.type) return res.status(400).json({ error: 'missing event' });

      const {
        type, app_user_id, product_id, transaction_id, store,
        environment, price_in_purchased_currency, price, currency,
      } = event;

      // 非購買/退款事件（TEST、TRANSFER…）→ 回 200 忽略，別讓 RevenueCat retry。
      if (!CREDIT_EVENTS.has(type) && !REFUND_EVENTS.has(type)) {
        return res.status(200).json({ ok: true, ignored: type });
      }

      const orderId = `iap_${transaction_id || event.id}`;

      // ── 退款事件：記錄，不自動扣幣 ─────────────────────────────
      if (REFUND_EVENTS.has(type)) {
        await supabase.from('coin_orders')
          .update({ refunded_at: new Date().toISOString(), refund_reason: type })
          .eq('order_id', orderId);
        console.warn('[iap] refund/cancel logged (no auto-deduct):', orderId, type);
        return res.status(200).json({ ok: true, refund_logged: true });
      }

      // ── 發幣事件 ───────────────────────────────────────────────
      const coins = getProductCoins()[product_id];
      if (!coins) {
        // 未知 product_id → 記一筆 failed 供排查，但回 200（別 retry；要先補對照）。
        console.error('[iap] unknown product_id, no coins mapping:', product_id);
        return res.status(200).json({ ok: false, reason: 'unknown_product', product_id });
      }
      if (!app_user_id) {
        console.error('[iap] missing app_user_id for', orderId);
        return res.status(200).json({ ok: false, reason: 'no_user' });
      }

      // ── 防護 2：idempotent（transaction_id 去重）───────────────
      // 已存在且已 paid → 重送，安全 noop。
      const { data: existing } = await supabase
        .from('coin_orders').select('status').eq('order_id', orderId).maybeSingle();
      if (existing && existing.status === 'paid') {
        return res.status(200).json({ ok: true, duplicate: true });
      }

      const provider = storeToProvider(store);
      const amount_twd = currency === 'TWD'
        ? Math.round(Number(price_in_purchased_currency ?? price ?? 0))
        : null;

      if (!existing) {
        const { error: insErr } = await supabase.from('coin_orders').insert({
          order_id: orderId,
          user_id: app_user_id,
          provider,
          tier: product_id,
          amount_twd,
          coins,
          status: 'paid',
          provider_order_id: transaction_id || null,
          paid_at: new Date().toISOString(),
          raw_callback: req.body,
        });
        if (insErr) {
          // 可能是併發重送撞唯一鍵 → 當作已處理，回 200。
          console.warn('[iap] coin_orders insert (likely dup):', insErr.message);
          return res.status(200).json({ ok: true, dup_insert: true });
        }
      } else {
        // 存在但非 paid（罕見）→ 補標 paid。
        await supabase.from('coin_orders')
          .update({ status: 'paid', paid_at: new Date().toISOString(), raw_callback: req.body })
          .eq('order_id', orderId).eq('status', 'pending');
      }

      // 入帳：直接加 profiles.coins（跟街口同一套），並寫 grant 作 audit。
      const { data: profile } = await supabase
        .from('profiles').select('coins').eq('user_id', app_user_id).maybeSingle();
      const newCoins = (profile?.coins || 0) + coins;
      await supabase.from('profiles').update({ coins: newCoins }).eq('user_id', app_user_id);
      await supabase.from('user_coin_grants').insert({
        user_id: app_user_id,
        coins,
        reason: `App 內購 (${product_id}${environment === 'SANDBOX' ? ' · 測試' : ''})`,
        from_name: provider === 'apple' ? 'App Store' : provider === 'google' ? 'Google Play' : 'IAP',
        claimed_at: new Date().toISOString(),
      });

      console.log(`[iap] credited ${coins} coins to ${app_user_id} (${orderId}, ${provider}, ${environment})`);
      return res.status(200).json({ ok: true, coins });
    } catch (e) {
      console.error('[iap] webhook error', e);
      // 回 500 讓 RevenueCat retry（它會重送）。但發幣段已 idempotent，重送安全。
      return res.status(500).json({ error: 'internal error' });
    }
  });
}

module.exports = { registerIapRoutes, DEFAULT_PRODUCT_COINS, getProductCoins };
