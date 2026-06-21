import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import RankFrame from './RankFrame'
import RankDefs from './RankDefs'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const TIER_RANK = { diamond: 0, gold: 1, dinner: 2, meal: 3, coffee: 4 }
const TIER_ICON = { diamond: '🦚', gold: '🏆', dinner: '🏮', meal: '🌾', coffee: '🍵' }
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
 * 首頁華麗感謝榜橫幅 — 套用排行榜段位「gold 金框」雕花(四角寶石+藤蔓+立體金邊+
 * 金光脈動+雕刻凹線)，內襯深金底配白字；下方「一次一句」輪播感謝詞(由下往上滑入)。
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
    <>
      <RankDefs />
      <button onClick={() => navigate('/sponsors')}
        className="block w-full text-left active:scale-[0.985] transition-transform">
        <RankFrame tier="gold" className="sponsor-rankframe">
          <span className="sponsor-sheen" aria-hidden="true" />
          <div className="relative z-10">
            <div className="flex items-center justify-between mb-1.5">
              <span className="flex items-center gap-1.5 text-white font-black text-sm tracking-wide rounded-full border border-amber-100/70 bg-black/25 px-2.5 py-1 backdrop-blur-sm shadow-[inset_0_1px_0_rgba(255,255,255,.25)]"
                    style={{ textShadow: '0 1px 4px rgba(70,35,0,.7)' }}>
                <span className="text-base">👑</span>
                感謝榜
                <span className="text-[10px] font-bold text-amber-50/85 ml-0.5">贊助維運的大大們</span>
              </span>
              <span className="text-amber-50 text-[11px] font-bold opacity-90">查看全部 ›</span>
            </div>
            <div className="sponsor-rotate-wrap">
              <span key={idx} className="sponsor-rotate-item text-white text-xs font-semibold whitespace-nowrap"
                    style={{ textShadow: '0 1px 3px rgba(70,35,0,.65)' }}>
                <span className="mr-1.5">{TIER_ICON[s.tier] || '💛'}</span>
                {pre}<b className="font-black text-amber-50 drop-shadow">{s.display_name}</b>{suf}
              </span>
            </div>
          </div>
        </RankFrame>
      </button>
    </>
  )
}
