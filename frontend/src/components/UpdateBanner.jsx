// App 內更新提醒（回饋：使用者不知道有新版、要自己去商店看）
// 只在原生 App 顯示：比對執行中版本 vs app-version.json 的最新版，較舊時跳橫幅。
// 使用者可關閉（記到 localStorage，同一版不再煩）。
import { useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { App as CapApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'

// 「1.0.4」→ [1,0,4]，逐段比較；a<b 回 true
function isOlder(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n) || 0)
  const pb = String(b).split('.').map(n => parseInt(n) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0
    if (x !== y) return x < y
  }
  return false
}

export default function UpdateBanner() {
  const [info, setInfo] = useState(null)   // { url }

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let cancelled = false
    ;(async () => {
      try {
        const platform = Capacitor.getPlatform()   // 'ios' | 'android'
        const cur = (await CapApp.getInfo())?.version
        const res = await fetch('/app-version.json', { cache: 'no-store' })
        const cfg = await res.json()
        const latest = platform === 'ios' ? cfg.ios : cfg.android
        const url = platform === 'ios' ? cfg.iosUrl : cfg.androidUrl
        if (cancelled || !cur || !latest || !url) return
        if (!isOlder(cur, latest)) return               // 已是最新
        if (localStorage.getItem('update-dismissed') === latest) return  // 這版關過了
        setInfo({ url, latest })
      } catch { /* 靜默：抓不到就不提示 */ }
    })()
    return () => { cancelled = true }
  }, [])

  if (!info) return null

  const openStore = async () => {
    try { await Browser.open({ url: info.url }) } catch { window.open(info.url, '_blank') }
  }
  const dismiss = () => { try { localStorage.setItem('update-dismissed', info.latest) } catch {}; setInfo(null) }

  return (
    <div className="fixed top-0 inset-x-0 z-[60] bg-medical-blue text-white px-4 py-2.5 flex items-center gap-2 shadow-lg">
      <span className="text-lg">🎉</span>
      <span className="text-sm flex-1 leading-tight">有新版本可以更新囉！新增功能與大量題目修正</span>
      <button onClick={openStore} className="text-xs font-bold bg-white text-medical-blue px-3 py-1.5 rounded-full active:scale-95 shrink-0">前往更新</button>
      <button onClick={dismiss} className="text-white/70 text-lg leading-none px-1 shrink-0" title="稍後">✕</button>
    </div>
  )
}
