import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const TIER_RANK = { diamond: 0, gold: 1, dinner: 2, meal: 3, coffee: 4 }
const TIER_ICON = { diamond: '🦚', gold: '🏆', dinner: '🏮', meal: '🌾', coffee: '🍵' }

/**
 * 首頁華麗感謝榜橫幅 — 金色流光 + 大乾爹名字跑馬燈，點擊進 /sponsors。
 * 放在「建立房間」上方（贊助者很重要，給最顯眼的位置）。
 */
export default function SponsorBanner() {
  const navigate = useNavigate()
  const [sponsors, setSponsors] = useState([])

  useEffect(() => {
    let alive = true
    fetch(`${BACKEND}/api/sponsors`)
      .then(r => r.json())
      .then(d => {
        if (!alive) return
        const list = (d.sponsors || []).slice()
          .sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9))
        setSponsors(list)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  if (!sponsors.length) return null

  const names = sponsors.slice(0, 12)
  const marquee = names.length > 3              // 夠多才跑馬燈，少的話靜態置中
  const items = marquee ? [...names, ...names] : names

  return (
    <button
      onClick={() => navigate('/sponsors')}
      className="sponsor-banner relative w-full rounded-2xl overflow-hidden active:scale-[0.98] transition-transform shadow-lg">
      <span className="sponsor-banner-sheen" aria-hidden="true" />
      <div className="relative px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-white font-black text-sm flex items-center gap-1.5" style={{ textShadow: '0 1px 3px rgba(0,0,0,.4)' }}>
            <span className="text-base">👑</span> 感謝榜
          </span>
          <span className="text-amber-50 text-[11px] font-bold opacity-90">感謝大大支持平台 ›</span>
        </div>
        <div className={`sponsor-marquee-wrap ${marquee ? '' : 'flex justify-center'}`}>
          <div className={`flex gap-2 ${marquee ? 'sponsor-marquee' : 'flex-wrap justify-center'}`}>
            {items.map((s, i) => (
              <span
                key={i}
                className="shrink-0 px-2.5 py-1 rounded-full bg-white/25 text-white text-xs font-bold border border-white/40 truncate max-w-[150px]"
                style={{ textShadow: '0 1px 2px rgba(0,0,0,.35)' }}>
                {TIER_ICON[s.tier] || '💛'} {s.display_name}
              </span>
            ))}
          </div>
        </div>
      </div>
    </button>
  )
}
