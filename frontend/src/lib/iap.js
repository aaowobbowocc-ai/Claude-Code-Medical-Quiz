/**
 * App 內購金幣（IAP）— RevenueCat 包裝。
 *
 * 只在 Native App 運作（Web 版一律走街口，見 CoinShopSheet）。
 * 金幣不在前端發放：購買成功後由 RevenueCat webhook 打後端
 * (/payment/iap/revenuecat) 寫進 profiles.coins；前端只負責觸發購買 + 輪詢餘額。
 *
 * RevenueCat SDK 公鑰（appl_xxx / goog_xxx）從 .env 帶入：
 *   VITE_RC_IOS_KEY / VITE_RC_ANDROID_KEY
 * 商品 ID：coins_2500 / coins_10000 / coins_35000（兩商店 + RevenueCat Offering 一致）。
 */
import { Capacitor } from '@capacitor/core'

const KEYS = {
  ios: import.meta.env.VITE_RC_IOS_KEY || '',
  android: import.meta.env.VITE_RC_ANDROID_KEY || '',
}

let initPromise = null
let Purchases = null

/** 是否在 App（iOS/Android）內。Web 版回 false，永遠不碰 native plugin。 */
export function isIapAvailable() {
  return Capacitor.isNativePlatform()
}

/** Lazy 初始化 RevenueCat（idempotent）。Web 版丟錯由呼叫端 catch。 */
async function ensureInit(appUserId) {
  if (!Capacitor.isNativePlatform()) throw new Error('IAP 僅 App 版可用')
  if (initPromise) return initPromise
  initPromise = (async () => {
    const mod = await import('@revenuecat/purchases-capacitor')
    Purchases = mod.Purchases
    const platform = Capacitor.getPlatform()
    const apiKey = platform === 'ios' ? KEYS.ios : KEYS.android
    if (!apiKey) throw new Error('RevenueCat API key 未設定')
    // appUserID 設成 Supabase user_id → webhook 的 app_user_id 就對得上、發幣到正確帳號
    await Purchases.configure({ apiKey, appUserID: appUserId || undefined })
    return mod
  })()
  return initPromise
}

/** 登入後呼叫一次，把購買掛在正確帳號下（webhook 靠這個 user_id 發幣）。 */
export async function setIapUser(appUserId) {
  if (!Capacitor.isNativePlatform() || !appUserId) return
  try {
    await ensureInit(appUserId)
    await Purchases.logIn({ appUserID: appUserId })
  } catch { /* 靜默：RC 未設定或 Web */ }
}

/** 取幣包清單：[{ id, productId, priceString, title, pkg }]，Offering 無設定則回 []。 */
export async function getCoinPackages(appUserId) {
  await ensureInit(appUserId)
  const offerings = await Purchases.getOfferings()
  const cur = offerings?.current
  if (!cur?.availablePackages?.length) return []
  return cur.availablePackages.map(p => ({
    id: p.identifier,
    productId: p.product?.identifier,
    priceString: p.product?.priceString,
    title: p.product?.title,
    pkg: p,
  }))
}

/** 購買。成功＝Apple/Google 已收款；金幣由 webhook 幾秒內入帳。使用者取消會 throw。 */
export async function buyCoinPackage(pkg, appUserId) {
  await ensureInit(appUserId)
  // ensureInit 是 idempotent，第二次以後不會重帶 appUserID；購買前再 logIn 一次，
  // 確保這筆掛在 supabase user_id 底下（掛成匿名 ID 的話 webhook 發不了幣）。
  if (appUserId) {
    try { await Purchases.logIn({ appUserID: appUserId }) } catch { /* 已是同一帳號 */ }
  }
  return await Purchases.purchasePackage({ aPackage: pkg })
}

/** 判斷是否為「使用者主動取消」（取消不算錯誤，不顯示失敗）。 */
export function isUserCancelled(e) {
  const c = String(e?.code ?? '')
  return e?.userCancelled === true || c === '1' || /cancel/i.test(e?.message || '')
}
