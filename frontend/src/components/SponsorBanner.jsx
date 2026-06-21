import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const TIER_RANK = { diamond: 0, gold: 1, dinner: 2, meal: 3, coffee: 4 }
const TIER_ICON = { diamond: '🦚', gold: '🏆', dinner: '🏮', meal: '🌾', coffee: '🍵' }
// 感謝句模板（[前綴, 後綴]，名字夾中間燙金）— 依序輪流，多句不重複
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
 * 首頁帝王風感謝榜橫幅 — 用 Sponsors hero 的龍紋邊(border-image 9-slice)圍邊，
 * 米色宣紙底 + 燙金「感謝榜」+ 朱紅感謝詞「一次一句」輪播。點擊進 /sponsors。
 */
export default function SponsorBanner() {
  const navigate = useNavigate()
  const [sponsors, setSponsors] = useState([])
  const [idx, setIdx] = useState(0)

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

  useEffect(() => {
    if (sponsors.length === 0) return
    const t = setInterval(() => setIdx(i => i + 1), 3600)
    return () => clearInterval(t)
  }, [sponsors.length])

  if (!sponsors.length) return null

  const s = sponsors[idx % sponsors.length]
  const [pre, suf] = THANKS[idx % THANKS.length]

  return (
    <button
      onClick={() => navigate('/sponsors')}
      className="sponsor-imperial block w-full text-left active:scale-[0.99] transition-transform">
      <div className="flex items-center justify-between mb-0.5">
        <span className="flex items-baseline gap-1.5">
          <span className="text-base leading-none">👑</span>
          <span className="sponsor-gold-text font-black text-base tracking-wider">感謝榜</span>
          <span className="text-[10px] font-bold" style={{ color: '#8b1818' }}>贊助維運的大大們</span>
        </span>
        <span className="text-[11px] font-bold" style={{ color: '#8b1818' }}>查看全部 ›</span>
      </div>
      <div className="sponsor-rotate-wrap">
        <span key={idx} className="sponsor-rotate-item text-xs font-bold whitespace-nowrap" style={{ color: '#7a2018' }}>
          <span className="mr-1">{TIER_ICON[s.tier] || '💛'}</span>
          {pre}<b className="sponsor-gold-text">{s.display_name}</b>{suf}
        </span>
      </div>
    </button>
  )
}
