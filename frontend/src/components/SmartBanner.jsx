import React, { useState, useEffect, useRef } from 'react'
import { isNativeApp } from '../lib/admob'

const AD_SLOT = '1093265050'
const AD_CLIENT = 'ca-pub-3134321405509741'

// Native App 不顯示：贊助按鈕含外部金流字眼，Play / App Store 政策地雷。
const IS_NATIVE = isNativeApp()

export default function SmartBanner() {
  const [dismissed, setDismissed] = useState(false)
  // ⚠️ 2026-10-26：直接進 fallback（贊助卡），不要再嘗試 AdSense。
  //
  // AD_CLIENT 與 AD_SLOT 都是寫死的非空字串，所以舊的
  // `useState(!AD_CLIENT || !AD_SLOT)` 初始值其實是 false ——
  // 這個元件掛在 Practice／MockExam／Results／Review 四個最常用的頁面上，
  // 等於每個使用者都被送一次請求到 googlesyndication，然後看 3 秒空廣告位
  // 才 fallback 成贊助卡。
  //
  // 而那些請求永遠不會有填充：發布商帳戶 pub-3134321405509741 的網站審查
  // 一直被判「缺乏價值的內容」，AdSense 從來沒在 examking.tw 上放送過。
  // （真正在賺錢的是 App 的 AdMob Rewarded，走同一個發布商帳戶收款，
  //   跟這個網頁廣告無關。）
  //
  // FixedBottomAd 早就這樣關掉了，這裡補上。
  // 日後網站真的過審，改回 useState(!AD_CLIENT || !AD_SLOT) 即可恢復。
  const [adFailed, setAdFailed] = useState(true)
  const adRef = useRef(null)

  useEffect(() => {
    if (adFailed || !AD_CLIENT) return

    // Load AdSense script if not already loaded
    if (!document.querySelector('script[src*="adsbygoogle"]')) {
      const s = document.createElement('script')
      s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${AD_CLIENT}`
      s.async = true
      s.crossOrigin = 'anonymous'
      s.onerror = () => setAdFailed(true)
      document.head.appendChild(s)
    }

    // Push ad
    const timer = setTimeout(() => {
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({})
      } catch {
        setAdFailed(true)
      }
    }, 500)

    // Check if ad rendered after 3s
    const check = setTimeout(() => {
      if (adRef.current) {
        const h = adRef.current.querySelector('ins')?.offsetHeight
        if (!h || h < 10) setAdFailed(true)
      }
    }, 3000)

    return () => { clearTimeout(timer); clearTimeout(check) }
  }, [adFailed])

  if (dismissed || IS_NATIVE) return null

  return (
    <div className="relative w-full mt-4 mb-2">
      {/* Ad / fallback content */}
      {adFailed ? (
        /* Fallback: 贊助/宣傳橫幅 */
        <div className="w-full rounded-2xl overflow-hidden border border-gray-100 shadow-sm"
             style={{ background: 'linear-gradient(135deg, #EFF6FF, #F0FDFA)' }}>
          <div className="flex items-center gap-3 px-4 py-3">
            <span className="text-3xl shrink-0">🩺</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-medical-dark leading-snug">支持國考知識王</p>
              <p className="text-xs text-gray-400 mt-0.5">你的贊助讓所有醫學生都能免費使用</p>
            </div>
            <button
              onClick={() => alert('贊助功能目前尚未開放，敬請期待！🙏')}
              className="shrink-0 text-xs font-bold px-3 py-1.5 rounded-lg text-white active:scale-95 transition-transform grad-cta"
            >
              贊助
            </button>
          </div>
        </div>
      ) : (
        /* Google AdSense */
        <div ref={adRef} className="w-full overflow-hidden rounded-2xl">
          <ins className="adsbygoogle"
               style={{ display: 'block', width: '100%', height: '90px' }}
               data-ad-client={AD_CLIENT}
               data-ad-slot={AD_SLOT}
               data-ad-format="horizontal"
               data-full-width-responsive="false" />
        </div>
      )}

      {/* 關閉按鈕 + 廣告標記 */}
      <div className="flex items-center justify-between mt-1.5 px-1">
        <span className="text-[10px] text-gray-300">
          {adFailed ? '' : '廣告'}
        </span>
        <p className="text-[10px] text-gray-300 text-center flex-1">
          廣告收益將全數用於維護國考題庫伺服器支出
        </p>
        <button
          onClick={() => setDismissed(true)}
          className="text-gray-300 text-xs leading-none hover:text-gray-400 ml-1"
        >
          &times;
        </button>
      </div>
    </div>
  )
}
