import React, { useState, useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'

const AD_SLOT = '1093265050'
const AD_CLIENT = 'ca-pub-3134321405509741'

// Pages where fixed bottom ad should NOT show
const HIDDEN_ROUTES = ['/game', '/lobby', '/board', '/privacy', '/tos', '/contact', '/practice', '/mock-exam', '/weakness']

export default function FixedBottomAd() {
  const { pathname } = useLocation()
  const [dismissed, setDismissed] = useState(false)
  const [adFailed, setAdFailed] = useState(!AD_CLIENT || !AD_SLOT)
  const adRef = useRef(null)
  const pushedRef = useRef(false)

  const hidden = HIDDEN_ROUTES.includes(pathname)

  useEffect(() => {
    if (hidden || adFailed || !AD_CLIENT || pushedRef.current) return

    if (!document.querySelector('script[src*="adsbygoogle"]')) {
      const s = document.createElement('script')
      s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${AD_CLIENT}`
      s.async = true
      s.crossOrigin = 'anonymous'
      s.onerror = () => setAdFailed(true)
      document.head.appendChild(s)
    }

    const timer = setTimeout(() => {
      try {
        if (!pushedRef.current) {
          ;(window.adsbygoogle = window.adsbygoogle || []).push({})
          pushedRef.current = true
        }
      } catch {
        setAdFailed(true)
      }
    }, 500)

    const check = setTimeout(() => {
      if (adRef.current) {
        const h = adRef.current.querySelector('ins')?.offsetHeight
        if (!h || h < 10) setAdFailed(true)
      }
    }, 3000)

    return () => { clearTimeout(timer); clearTimeout(check) }
  }, [hidden, adFailed])

  if (hidden || dismissed) return null

  return (
    <>
      {/* Spacer so page content isn't hidden behind fixed ad */}
      <div className="h-20 shrink-0" />

      {/* Fixed bottom ad */}
      <div className="fixed bottom-0 left-0 right-0 z-50" style={{ maxWidth: '480px', margin: '0 auto' }}>
        {adFailed ? (
          <div className="mx-2 mb-1 rounded-t-2xl overflow-hidden border border-gray-200 shadow-lg bg-white">
            <div className="flex items-center gap-2 px-3 py-2.5"
                 style={{ background: 'linear-gradient(135deg, #EFF6FF, #F0FDFA)' }}>
              <span className="text-2xl shrink-0">🩺</span>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-medical-dark leading-snug">支持知識王</p>
                <p className="text-[10px] text-gray-400 truncate">你的支持讓所有考生都能免費使用</p>
              </div>
              <a
                href="https://p.ecpay.com.tw/E11DBDD"
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 px-3 py-1.5 rounded-full text-[11px] font-bold text-white active:scale-95 transition-transform shadow-sm"
                style={{ background: 'linear-gradient(135deg, #F59E0B, #EF4444)' }}
              >☕ 贊助</a>
              <button
                onClick={() => setDismissed(true)}
                className="shrink-0 text-gray-400 text-lg leading-none px-1"
                aria-label="關閉"
              >&times;</button>
            </div>
          </div>
        ) : (
          <div className="mx-2 mb-1 rounded-t-2xl overflow-hidden shadow-lg bg-white border border-gray-200">
            <div className="flex items-center justify-between px-2 pt-1">
              <span className="text-[9px] text-gray-300">廣告</span>
              <button
                onClick={() => setDismissed(true)}
                className="text-gray-300 text-xs leading-none hover:text-gray-400 px-1"
              >&times;</button>
            </div>
            <div ref={adRef}>
              <ins className="adsbygoogle"
                   style={{ display: 'block', width: '100%', height: '60px' }}
                   data-ad-client={AD_CLIENT}
                   data-ad-slot={AD_SLOT}
                   data-ad-format="horizontal"
                   data-full-width-responsive="false" />
            </div>
          </div>
        )}
      </div>
    </>
  )
}
