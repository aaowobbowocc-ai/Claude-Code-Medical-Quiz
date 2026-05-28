/**
 * 感謝榜 — 公開展示所有贊助者，依金額排序。
 *
 * 由 FEATURE_SPONSORS feature flag 控制，OFF 時整頁回首頁。
 */
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { FEATURE_SPONSORS } from '../config/featureFlags'
import Footer from '../components/Footer'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

const TIER_BADGE = {
  coffee:  { emoji: '☕',  label: '小杯咖啡', range: 'NT$50+',    color: 'bg-amber-50 text-amber-700 border-amber-200' },
  meal:    { emoji: '🍱',  label: '一個便當', range: 'NT$150+',   color: 'bg-blue-50 text-blue-700 border-blue-200' },
  dinner:  { emoji: '🍷',  label: '一頓晚餐', range: 'NT$500+',   color: 'bg-purple-50 text-purple-700 border-purple-200' },
  gold:    { emoji: '🏆',  label: '黃金贊助', range: 'NT$1000+',  color: 'bg-yellow-50 text-yellow-700 border-yellow-300' },
  diamond: { emoji: '💎',  label: '鑽石贊助', range: 'NT$3000+',  color: 'bg-cyan-50 text-cyan-700 border-cyan-300' },
}

export default function Sponsors() {
  const navigate = useNavigate()
  const [sponsors, setSponsors] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)

  useEffect(() => {
    if (!FEATURE_SPONSORS) { navigate('/', { replace: true }); return }
    fetch(`${BACKEND}/api/sponsors`)
      .then(r => r.json())
      .then(d => {
        if (d.error) setErr(d.error)
        else setSponsors(d.sponsors || [])
      })
      .catch(() => setErr('連線失敗'))
      .finally(() => setLoading(false))
  }, [])

  if (!FEATURE_SPONSORS) return null

  // 依 tier 分組
  const byTier = sponsors.reduce((acc, s) => {
    (acc[s.tier] = acc[s.tier] || []).push(s)
    return acc
  }, {})
  const tierOrder = ['diamond', 'gold', 'dinner', 'meal', 'coffee']

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      <div className="grad-header px-4 pt-5 pb-5">
        <button onClick={() => navigate(-1)} className="text-white/80 text-sm mb-2 active:opacity-70">‹ 返回</button>
        <h1 className="text-2xl font-bold text-white">🙏 感謝榜</h1>
        <p className="text-white/70 text-xs mt-1">感謝以下贊助者支持平台維運，讓國考知識王持續免費為大家服務</p>
      </div>

      <div className="px-4 py-4 flex-1">
        {loading && <p className="text-center text-gray-400 py-10">載入中…</p>}
        {err && <p className="text-center text-red-500 py-10">{err}</p>}

        {!loading && !err && sponsors.length === 0 && (
          <div className="bg-white rounded-2xl shadow-sm p-6 text-center">
            <div className="text-5xl mb-3">🌱</div>
            <p className="text-medical-dark font-bold">尚未有贊助紀錄</p>
            <p className="text-gray-400 text-sm mt-2">成為第一位贊助者，留下你的名字在這裡！</p>
            <a
              href="https://p.ecpay.com.tw/E11DBDD"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-4 px-6 py-2.5 rounded-xl bg-medical-blue text-white font-bold text-sm active:scale-95"
            >
              ☕ 用綠界贊助
            </a>
          </div>
        )}

        {!loading && !err && tierOrder.map(t => {
          const list = byTier[t]
          if (!list || list.length === 0) return null
          const meta = TIER_BADGE[t]
          return (
            <div key={t} className="mb-5">
              <div className={`px-3 py-1.5 rounded-full inline-flex items-center gap-2 border ${meta.color} mb-2`}>
                <span>{meta.emoji}</span>
                <span className="font-bold text-xs">{meta.label}</span>
                <span className="text-[10px] opacity-70">{meta.range}</span>
              </div>
              <div className="space-y-2">
                {list.map((s, i) => (
                  <div key={i} className="bg-white rounded-2xl shadow-sm border border-gray-100 px-4 py-3 flex items-center justify-between">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <span className="text-2xl shrink-0">{meta.emoji}</span>
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-medical-dark text-sm truncate">{s.display_name}</p>
                        {s.message && (
                          <p className="text-xs text-gray-500 truncate mt-0.5">"{s.message}"</p>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0 ml-3">
                      <p className="text-xs text-gray-400">NT${s.amount_ntd}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}

        {!loading && !err && sponsors.length > 0 && (
          <div className="bg-blue-50 rounded-2xl p-4 mt-6 text-sm text-blue-800">
            <p className="font-bold mb-1">也想留名感謝榜？</p>
            <p className="text-xs leading-relaxed mb-3">
              透過綠界贊助任何金額，1-2 天內會手動加上你的名字。可選擇匿名或自訂顯示名稱。
            </p>
            <a
              href="https://p.ecpay.com.tw/E11DBDD"
              target="_blank"
              rel="noopener noreferrer"
              className="block text-center bg-medical-blue text-white font-bold py-2.5 rounded-xl active:scale-95"
            >
              ☕ 用綠界贊助
            </a>
          </div>
        )}
      </div>

      <Footer />
    </div>
  )
}
