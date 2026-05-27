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

// 正式 Ad Unit ID（從 AdMob console 申請來，bundle 進 APK 是公開資訊）
const PROD_AD_UNITS = {
  android: 'ca-app-pub-3134321405509741/7221058627',
  ios: null, // iOS 之後再申請
}

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

  // Prepare (loads the ad). If a previous prepared ad is still cached, this
  // is essentially a no-op.
  await mod.AdMob.prepareRewardVideoAd({
    adId,
    isTesting: import.meta.env.DEV,
  })

  // Show + wait for either Rewarded event (success) or Dismissed (skip).
  // The SDK fires events; we wrap in a Promise.
  return new Promise((resolve, reject) => {
    let rewarded = false
    let listeners = []

    const cleanup = () => {
      for (const l of listeners) {
        try { l.remove() } catch {}
      }
    }

    listeners.push(mod.AdMob.addListener(mod.RewardAdPluginEvents.Rewarded, () => {
      rewarded = true
    }))
    listeners.push(mod.AdMob.addListener(mod.RewardAdPluginEvents.Dismissed, () => {
      cleanup()
      resolve(rewarded)
    }))
    listeners.push(mod.AdMob.addListener(mod.RewardAdPluginEvents.FailedToShow, (err) => {
      cleanup()
      reject(new Error(`AdMob FailedToShow: ${err?.message || err?.code || 'unknown'}`))
    }))

    mod.AdMob.showRewardVideoAd().catch(err => {
      cleanup()
      reject(err)
    })
  })
}

/** True if running inside the Android/iOS App shell. Used by useAdReward. */
export function isNativeApp() {
  return Capacitor.isNativePlatform()
}
