/**
 * Capacitor Native App 啟動初始化。Web 版完全 no-op。
 *
 * 在 Native 啟動時：
 *   1. 設定 status bar 顏色配 theme（深藍 #1A6B9A）
 *   2. App ready 後 hide splash screen（從 1.5 秒 → 立刻關）
 *   3. 設定 Android 系統返回鍵：在 root 路由按返回 → 縮小 App，不離開
 */
import { Capacitor } from '@capacitor/core'

export async function initCapacitor() {
  if (!Capacitor.isNativePlatform()) return

  try {
    const [{ StatusBar, Style }, { SplashScreen }, { App }] = await Promise.all([
      import('@capacitor/status-bar'),
      import('@capacitor/splash-screen'),
      import('@capacitor/app'),
    ])

    // Status bar — 深色背景 + 淺色 icon
    try {
      await StatusBar.setStyle({ style: Style.Dark })
      await StatusBar.setBackgroundColor({ color: '#1A6B9A' })
    } catch (e) {
      console.warn('[capacitor] StatusBar setup failed:', e.message)
    }

    // App ready — hide splash
    try {
      // 等 first paint 一下（避免閃白）
      requestAnimationFrame(() => {
        setTimeout(() => SplashScreen.hide({ fadeOutDuration: 250 }), 100)
      })
    } catch (e) {
      console.warn('[capacitor] SplashScreen hide failed:', e.message)
    }

    // Android 返回鍵：root 頁面按返回 → 縮小 App 而不是退出
    try {
      App.addListener('backButton', ({ canGoBack }) => {
        if (!canGoBack) {
          App.minimizeApp()
        } else {
          window.history.back()
        }
      })
    } catch (e) {
      console.warn('[capacitor] backButton listener failed:', e.message)
    }
  } catch (e) {
    // Plugin imports fail in web build — silently skip
    console.warn('[capacitor] init skipped:', e.message)
  }
}
