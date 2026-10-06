/**
 * AdMob SDK wrapper for native Android App (Capacitor).
 *
 * 載入時偵測 Native 平台才 import @capacitor-community/admob，
 * Web 版完全不會 bundle native code。
 *
 * Test Ad Unit IDs（Google 官方測試 unit，不會被偵測為 invalid click）：
 *   Android Rewarded: ca-app-pub-3940256099942544/5224354917
 *   iOS Rewarded:     ca-app-pub-3940256099942544/1712485313
 *
 * Production Ad Unit IDs 從 .env 帶入：
 *   VITE_ADMOB_ANDROID_REWARDED=ca-app-pub-XXX/YYY
 *   VITE_ADMOB_IOS_REWARDED=ca-app-pub-XXX/YYY
 */
import { Capacitor } from '@capacitor/core'

const TEST_AD_UNITS = {
  android: 'ca-app-pub-3940256099942544/5224354917',
  ios: 'ca-app-pub-3940256099942544/1712485313',
}

// 正式 Ad Unit ID（從 AdMob console 申請來，bundle 進 APK/IPA 是公開資訊）
const PROD_AD_UNITS = {
  android: 'ca-app-pub-3134321405509741/7221058627',
  ios: 'ca-app-pub-3134321405509741/5674824070',
}

// iOS App ID（要寫進 Info.plist 的 GADApplicationIdentifier）
// Android App ID 在 AndroidManifest.xml 已設好
export const IOS_ADMOB_APP_ID = 'ca-app-pub-3134321405509741~8300987419'

let initPromise = null
let AdMobModule = null

/** Lazy-load and initialize the AdMob plugin (idempotent). */
async function ensureInit() {
  if (!Capacitor.isNativePlatform()) return null
  if (initPromise) return initPromise

  initPromise = (async () => {
    // Dynamic import so web builds don't bundle the native plugin.
    const mod = await import('@capacitor-community/admob')
    AdMobModule = mod
    await mod.AdMob.initialize({
      // testingDevices: [...]  // add device IDs for test ad serving on real device
      initializeForTesting: import.meta.env.DEV,
    })
    return mod
  })()
  return initPromise
}

/** Get the right Ad Unit ID for current platform.
 *  - DEV mode: 用 Google 官方測試 ID（不會被偵測為 invalid click，安全測試用）
 *  - PROD mode: 用真實 Ad Unit ID（可被 .env 覆寫，預設用 PROD_AD_UNITS） */
function getRewardedAdUnitId() {
  const platform = Capacitor.getPlatform()
  if (import.meta.env.DEV) return TEST_AD_UNITS[platform] || TEST_AD_UNITS.android
  if (platform === 'android') {
    return import.meta.env.VITE_ADMOB_ANDROID_REWARDED || PROD_AD_UNITS.android
  }
  if (platform === 'ios') {
    return import.meta.env.VITE_ADMOB_IOS_REWARDED || PROD_AD_UNITS.ios || TEST_AD_UNITS.ios
  }
  return null
}

/**
 * Show an AdMob Rewarded Video ad. Resolves with true if the user
 * completed the ad (eligible for reward), false otherwise.
 * Throws if called on Web (caller should check Capacitor.isNativePlatform).
 */
export async function showRewarded() {
  const mod = await ensureInit()
  if (!mod) throw new Error('AdMob unavailable: not on a native platform')
  const adId = getRewardedAdUnitId()
  if (!adId) throw new Error('No Rewarded Ad Unit ID configured')

  // 上一次呼叫若卡住沒結算，它的 listener 會留著，然後把**這一次**的事件吃掉
  // ——使用者回報「中途關掉廣告之後，下一次看完也領不到」就是這樣來的。
  // 進場先把 AdMob 的 listener 清乾淨（這個外掛的 listener 只有這裡會註冊）。
  try { await mod.AdMob.removeAllListeners() } catch {}

  // Prepare (loads the ad). If a previous prepared ad is still cached, this
  // is essentially a no-op.
  await mod.AdMob.prepareRewardVideoAd({
    adId,
    isTesting: import.meta.env.DEV,
  })

  // ⚠️ Capacitor 6/7 的 AdMob.addListener 回傳的是 Promise<PluginListenerHandle>，
  // 不是同步 handle。要先 await 三個 listener 都掛好再 show，否則早於掛載觸發的
  // 事件會整個漏接。
  //
  // ⚠️ **結算點是 Rewarded，不是 Dismissed。**
  // Rewarded（userDidEarnReward）才是 AdMob 認定「使用者已賺得獎勵」的權威訊號；
  // Dismissed 只是廣告關閉。舊版等 Dismissed 才結算，於是在 iOS 上只要使用者
  // 強制關掉、App 被切到背景、或廣告本身當掉，Dismissed 就不會來，
  // 已經賺到的獎勵直接被丟掉（使用者實測：看完沒加幣、今日次數也沒加；
  // 更怪的是重開 App 後才看到 +300，那是卡住的 Promise 被下一次的事件解開才送出的）。
  return new Promise((resolve, reject) => {
    let settled = false
    const handles = []
    const cleanup = () => {
      for (const h of handles) { try { h.remove() } catch {} }
    }
    const settle = (fn, val) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      fn(val)
    }
    // 保險絲：任何事件都沒來也不能永遠 pending，否則 UI 卡在「播放中」，
    // 而且 listener 會留到下一次去吃掉別人的事件。
    const timer = setTimeout(() => settle(resolve, false), 5 * 60 * 1000)

    Promise.all([
      mod.AdMob.addListener(mod.RewardAdPluginEvents.Rewarded, () => settle(resolve, true)),
      mod.AdMob.addListener(mod.RewardAdPluginEvents.Dismissed, () => settle(resolve, false)),
      mod.AdMob.addListener(mod.RewardAdPluginEvents.FailedToShow, (err) =>
        settle(reject, new Error(`AdMob FailedToShow: ${err?.message || err?.code || 'unknown'}`))),
    ])
      .then((ls) => {
        handles.push(...ls)
        return mod.AdMob.showRewardVideoAd()
      })
      .catch((err) => settle(reject, err instanceof Error ? err : new Error(String(err?.message || err))))
  })
}

/** True if running inside the Android/iOS App shell. Used by useAdReward. */
export function isNativeApp() {
  return Capacitor.isNativePlatform()
}

/**
 * iOS App Tracking Transparency：請求追蹤授權（彈出系統「允許追蹤」對話框）。
 * App Store Guideline 2.1 要求：宣告用 ATT 就必須在收集追蹤資料前真的跳這個彈窗。
 * 只在 iOS 跑；status 為 notDetermined（首次）才會真的彈，之後呼叫只回傳結果不重彈。
 * 必須在 App 進入 active 狀態後呼叫，否則彈窗不會出現（由 capacitor-init 延遲呼叫）。
 */
export async function requestATT() {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'ios') return
  try {
    const mod = await import('@capacitor-community/admob')
    const res = await mod.AdMob.trackingAuthorizationStatus()
    if (res?.status === 'notDetermined') {
      await mod.AdMob.requestTrackingAuthorization()
    }
  } catch (e) {
    console.warn('[admob] ATT request failed:', e?.message)
  }
}
