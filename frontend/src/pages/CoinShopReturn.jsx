import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

// 街口付款頁完成後 result_display_url 會把瀏覽器導回這裡（/coin-shop/return?order=xxx）。
// 用 order 反查後端狀態：付款成功時金幣已直接入帳 profiles.coins（後端 callback 處理）。
export default function CoinShopReturn() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const orderId = params.get('order')
  const [state, setState] = useState('checking') // checking | paid | failed | expired | timeout | notfound
  const [coins, setCoins] = useState(0)
  const pollRef = useRef(null)

  useEffect(() => {
    if (!orderId) { setState('notfound'); return }
    let attempts = 0
    const maxAttempts = 60 // 60 × 3s = 3 分鐘
    const check = async () => {
      attempts++
      try {
        const r = await fetch(`${BACKEND}/payment/jkos/status/${orderId}`)
        if (r.ok) {
          const o = await r.json()
          if (o.status === 'paid') {
            setCoins(o.coins || 0); setState('paid'); clearInterval(pollRef.current); return
          }
          if (o.status === 'failed') { setState('failed'); clearInterval(pollRef.current); return }
          if (o.status === 'expired') { setState('expired'); clearInterval(pollRef.current); return }
        } else if (r.status === 404) {
          setState('notfound'); clearInterval(pollRef.current); return
        }
      } catch {}
      if (attempts >= maxAttempts) { setState('timeout'); clearInterval(pollRef.current) }
    }
    check()
    pollRef.current = setInterval(check, 3000)
    return () => clearInterval(pollRef.current)
  }, [orderId])

  // 金幣入帳在 profiles.coins（後端）；回首頁時 reload 讓前端重新同步餘額
  const goHome = () => { navigate('/'); window.location.reload() }

  return (
    <div className="flex flex-col items-center justify-center min-h-dvh bg-medical-ice px-6">
      <div className="bg-white rounded-3xl shadow-xl px-6 py-10 w-full max-w-sm text-center">
        {state === 'checking' && (
          <>
            <div className="text-5xl mb-4 animate-pulse">⏳</div>
            <h1 className="text-xl font-bold text-medical-dark">確認付款中…</h1>
            <p className="text-gray-400 text-sm mt-2">正在向街口確認交易結果，請稍候。</p>
          </>
        )}
        {state === 'paid' && (
          <>
            <div className="text-5xl mb-3">🎉</div>
            <h1 className="text-xl font-bold text-medical-dark mb-1">付款成功，感謝你的贊助！</h1>
            <p className="text-gray-400 text-sm leading-relaxed mb-5">
              正是有你的支持，<br />這個平台才能持續免費提供給所有備考的同學。
            </p>
            <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-4 mb-6">
              <p className="text-amber-700 font-bold text-lg">
                🪙 +{(coins || 0).toLocaleString()} 金幣已入帳
              </p>
            </div>
            <button onClick={goHome} className="px-10 py-3 rounded-2xl font-bold text-white active:scale-95 grad-cta">
              繼續練習
            </button>
          </>
        )}
        {(state === 'failed' || state === 'expired') && (
          <>
            <div className="text-5xl mb-3">{state === 'expired' ? '⌛' : '😕'}</div>
            <h1 className="text-xl font-bold text-medical-dark mb-1">
              {state === 'expired' ? '訂單已過期' : '付款未完成'}
            </h1>
            <p className="text-gray-400 text-sm mt-2 mb-6">沒有扣款，可以再試一次。若已扣款金幣會自動入帳。</p>
            <button onClick={goHome} className="px-10 py-3 rounded-2xl font-bold text-white active:scale-95 grad-cta">
              返回首頁
            </button>
          </>
        )}
        {state === 'timeout' && (
          <>
            <div className="text-5xl mb-3">🕐</div>
            <h1 className="text-xl font-bold text-medical-dark mb-1">確認中</h1>
            <p className="text-gray-400 text-sm mt-2 mb-6">
              交易結果確認時間較長，若已完成付款，金幣會自動入帳。<br />可先返回首頁，稍後查看餘額。
            </p>
            <button onClick={goHome} className="px-10 py-3 rounded-2xl font-bold text-white active:scale-95 grad-cta">
              返回首頁
            </button>
          </>
        )}
        {state === 'notfound' && (
          <>
            <div className="text-5xl mb-3">❓</div>
            <h1 className="text-xl font-bold text-medical-dark mb-1">找不到訂單</h1>
            <p className="text-gray-400 text-sm mt-2 mb-6">查無此筆交易，若已扣款請聯絡客服。</p>
            <button onClick={goHome} className="px-10 py-3 rounded-2xl font-bold text-white active:scale-95 grad-cta">
              返回首頁
            </button>
          </>
        )}
      </div>
    </div>
  )
}
