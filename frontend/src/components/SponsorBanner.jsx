import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const TIER_RANK = { diamond: 0, gold: 1, dinner: 2, meal: 3, coffee: 4 }
const TIER_ICON = { diamond: '🦚', gold: '🏆', dinner: '🏮', meal: '🌾', coffee: '🍵' }
// 高等級給更亮的膠囊，低等級用半透明白
const TIER_PILL = {
  diamond: 'bg-cyan-50 text-cyan-900 border-cyan-200/80 shadow-[0_0_10px_rgba(165,243,252,.6)]',
  gold:    'bg-amber-50 text-amber-900 border-amber-200/80 shadow-[0_0_8px_rgba(253,230,138,.5)]',
}
// 感謝句模板（[前綴, 後綴]，名字夾中間加粗）— 依序輪流，多句不重複
const THANKS = [
  ['感謝 ', ' 對本平台的大力支持'],
  ['謝謝 ', ' 慷慨贊助，讓平台持續運作'],
  ['', ' 的支持，讓更多考生免費刷題'],
  ['由衷感謝 ', ' 的鼎力相助'],
  ['', ' 是平台最強後盾，感謝有你'],
  ['感謝 ', ' 贊助伺服器與 AI 維運'],
  ['有 ', ' 真好，謝謝你的支持'],
  ['謝謝 ', ' 讓國考知識王走得更遠'],
]

/**
 * 首頁華麗感謝榜橫幅 — 金色漸層 + 流光掃過 + 大乾爹名字無縫跑馬燈。
 * 放在「建立房間」上方（贊助者最重要，給最顯眼位置）。點擊進 /sponsors。
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
        setSponsors((d.sponsors || []).slice()
          .sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9)))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  if (!sponsors.length) return null

  const names = sponsors.slice(0, 20)
  // 重複填到夠寬，再整份複製一次 → 不論幾個贊助者都能無縫捲動
  let filled = []
  while (filled.length < 12) filled = filled.concat(names)
  const loop = [...filled, ...filled]
  const duration = Math.max(14, filled.length * 1.7) // 速度一致

  return (
    <button
      onClick={() => navigate('/sponsors')}
      className="sponsor-banner group relative w-full rounded-2xl overflow-hidden active:scale-[0.985] transition-transform">
      <span className="sponsor-banner-glow" aria-hidden="true" />
      <span className="sponsor-banner-sheen" aria-hidden="true" />
      <div className="relative px-4 pt-2.5 pb-3">
        <div className="flex items-center justify-between mb-2">
          <span className="flex items-center gap-1.5 text-white font-black text-sm tracking-wide rounded-full border border-amber-100/70 bg-black/20 px-2.5 py-1 backdrop-blur-sm shadow-[inset_0_1px_0_rgba(255,255,255,.25)]"
                style={{ textShadow: '0 1px 4px rgba(90,45,0,.6)' }}>
            <span className="text-base">👑</span>
            感謝榜
            <span className="text-[10px] font-bold text-amber-50/85 ml-0.5">贊助維運的大大們</span>
          </span>
          <span className="text-amber-50 text-[11px] font-bold opacity-90">查看全部 ›</span>
        </div>
        <div className="sponsor-marquee-wrap">
          <div className="flex items-center gap-3 w-max sponsor-marquee" style={{ animationDuration: `${duration}s` }}>
            {loop.map((s, i) => {
              const [pre, suf] = THANKS[i % THANKS.length]
              return (
                <span key={i} className="shrink-0 flex items-center gap-1.5 text-white text-xs font-semibold whitespace-nowrap"
                      style={{ textShadow: '0 1px 3px rgba(90,45,0,.55)' }}>
                  <span className="text-sm">{TIER_ICON[s.tier] || '💛'}</span>
                  <span>{pre}<b className="font-black text-amber-50 drop-shadow">{s.display_name}</b>{suf}</span>
                  <span className="text-amber-100/55 ml-1.5">✦</span>
                </span>
              )
            })}
          </div>
        </div>
      </div>
    </button>
  )
}
