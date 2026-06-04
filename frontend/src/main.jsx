import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import * as Sentry from '@sentry/react'
import App from './App'
import './index.css'
import { usePlayerStore } from './store/gameStore'
import { initCapacitor } from './lib/capacitor-init'

// Native App 啟動初始化（Web 版 no-op）
initCapacitor()

// Sentry — production-only error tracking. No-op if VITE_SENTRY_DSN unset
// (e.g. local dev or before user provisions the project).
const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN
if (SENTRY_DSN && import.meta.env.PROD) {
  Sentry.init({
    dsn: SENTRY_DSN,
    // Let SDK include its default integrations (GlobalHandlers / Breadcrumbs /
    // Dedupe / etc) — those are needed to actually capture window.onerror.
    // Just disable the heavy / paid-tier ones via the filter below.
    defaultIntegrations: undefined,
    integrations: (defaults) =>
      defaults.filter(i =>
        i.name !== 'BrowserTracing' &&
        i.name !== 'Replay' &&
        i.name !== 'BrowserProfiling'
      ),
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    environment: 'production',
    ignoreErrors: [
      'ResizeObserver loop limit exceeded',
      'Non-Error promise rejection captured',
      /Network request failed/,
      // Supabase auth multi-tab lock contention — benign, fires when another
      // browser tab refreshes the session token concurrently. 各種訊息變體都過濾。
      /Lock/i,             // 任何含 "Lock" 的訊息（Supabase 內建機制，永遠是雜訊）
      /AbortError/i,       // Supabase 取消請求觸發
      /stolen|steal/i,     // lock stealing 系列
      // 第三方 App 內建瀏覽器(FB/LINE/Messenger 等)注入的效能記錄腳本，在其 WebView
      // Java 橋接銷毀時報的錯，與本站程式無關、不影響使用者。
      /Java object is gone/i,
      /Java bridge/i,
    ],
    // 忽略來自第三方 in-app browser 注入腳本的錯誤（不是我們的程式碼）
    denyUrls: [
      /iabjs:/i,
      /navigation_performance_logger/i,
    ],
  })
}

// Apply saved dark mode before render (avoid flash)
try {
  const stored = JSON.parse(localStorage.getItem('medical-quiz-player') || '{}')
  if (stored.state?.darkMode) {
    document.documentElement.classList.add('dark')
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.content = '#1a1714'
  }
} catch {}

// Wait for zustand persist to rehydrate from localStorage, then sync with Supabase.
// (If we synced before persist finished, we'd upload empty defaults instead of the user's real local state.)
function syncProfile() {
  usePlayerStore.getState().hydrateFromCloud()
}
if (usePlayerStore.persist.hasHydrated()) {
  syncProfile()
} else {
  const unsub = usePlayerStore.persist.onFinishHydration(() => {
    syncProfile()
    unsub()
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <Sentry.ErrorBoundary fallback={({ resetError }) => (
    <div className="flex flex-col items-center justify-center min-h-dvh p-6 text-center">
      <p className="text-5xl mb-3">😵</p>
      <h1 className="text-xl font-bold text-gray-700 mb-2">頁面發生錯誤</h1>
      <p className="text-sm text-gray-500 mb-5 max-w-sm leading-relaxed">
        我們已收到錯誤回報，馬上會處理。<br />可以試試重新整理或回首頁。
      </p>
      <div className="flex gap-2">
        <button onClick={resetError} className="px-5 py-2.5 rounded-xl bg-medical-blue text-white font-semibold active:scale-95">重試</button>
        <button onClick={() => { window.location.href = '/' }} className="px-5 py-2.5 rounded-xl bg-gray-100 text-gray-700 font-semibold active:scale-95">回首頁</button>
      </div>
    </div>
  )}>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </Sentry.ErrorBoundary>
)

// Register service worker for PWA offline support — 主動觸發 update 確保
// 使用者不會卡在舊 SW（之前 /shop 載入 bug 修復卡在舊 cache 1+ 天）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      // 每次頁面載入時主動檢查 SW 更新
      reg.update().catch(() => {})
      // 新 SW 安裝完並啟用後，自動 reload 一次拿全新 bundle
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing
        if (!nw) return
        nw.addEventListener('statechange', () => {
          if (nw.state === 'activated' && navigator.serviceWorker.controller) {
            // 只在「已有舊 SW 控制中」時 reload，避免首次安裝重複 reload
            if (!sessionStorage.getItem('sw-reloaded-once')) {
              sessionStorage.setItem('sw-reloaded-once', '1')
              window.location.reload()
            }
          }
        })
      })
    }).catch(() => {})
  })
}
