/**
 * 感謝榜 — 進士金榜風格（Imperial Scholar Gold List）
 *
 * 視覺：燙金 + 朱印 + 宣紙底，刻意營造「上榜」的儀式感。
 * 由 FEATURE_SPONSORS feature flag 控制，OFF 時整頁回首頁。
 */
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { FEATURE_SPONSORS } from '../config/featureFlags'
import Footer from '../components/Footer'
import '../styles/sponsors.css'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const ECPAY_URL = 'https://p.ecpay.com.tw/14E6254'

const TIER_META = {
  diamond: { emoji: '🦚', label: '鴻名贊助', range: 'NT$3,000 +',  cardClass: 'diamond-card' },
  gold:    { emoji: '🏆', label: '鴻儒贊助', range: 'NT$1,000 +',  cardClass: 'gold-card' },
  dinner:  { emoji: '🏮', label: '厚意贊助', range: 'NT$500 +',    cardClass: 'dinner-card' },
  meal:    { emoji: '🌾', label: '心意贊助', range: 'NT$150 +',    cardClass: 'meal-card' },
  coffee:  { emoji: '🍵', label: '結緣贊助', range: 'NT$50 +',     cardClass: 'coffee-card' },
}

const TIER_ORDER = ['diamond', 'gold', 'dinner', 'meal', 'coffee']

/* ── 贊助卡片 — 同一份資料，依 tier 套不同外殼 ────────────── */
function SponsorCard({ sponsor, tier }) {
  const meta = TIER_META[tier]
  const isDiamond = tier === 'diamond'
  const isGold = tier === 'gold'
  const wrapClass = meta.cardClass

  const inner = (
    <div className="flex items-center gap-3 relative">
      <span className={`shrink-0 ${isDiamond ? 'text-3xl' : isGold ? 'text-2xl' : 'text-xl'}`}>
        {meta.emoji}
      </span>
      <div className="flex-1 min-w-0">
        <p className={`font-imperial font-bold truncate ${
          isDiamond ? 'text-lg text-stone-800' :
          isGold ? 'text-base text-stone-800' :
          'text-sm text-stone-700'
        }`}>
          {sponsor.display_name}
        </p>
        {sponsor.message && (
          <p className={`italic mt-0.5 truncate text-stone-500 ${
            isDiamond ? 'text-sm' : 'text-xs'
          }`}>
            「{sponsor.message}」
          </p>
        )}
      </div>
    </div>
  )

  if (isDiamond) {
    return (
      <div className={wrapClass}>
        <div className="diamond-card-inner">{inner}</div>
      </div>
    )
  }
  if (isGold) {
    return (
      <div className={wrapClass}>
        <div className="gold-card-inner">{inner}</div>
      </div>
    )
  }
  return <div className={wrapClass}>{inner}</div>
}

/* ── tier 分隔線 ──────────────────────────────────────────── */
function TierDivider({ meta, count }) {
  return (
    <div className="imperial-divider">
      <span className="imperial-divider-content">
        {meta.emoji} {meta.label} {count > 0 && <span className="opacity-60">· {count} 位</span>}
      </span>
    </div>
  )
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
        if (d.error) setErr('榜單敬載中 · 暫時無法顯示')
        else setSponsors(d.sponsors || [])
      })
      .catch(() => setErr('連線失敗，請稍後再試'))
      .finally(() => setLoading(false))
  }, [])

  if (!FEATURE_SPONSORS) return null

  const byTier = sponsors.reduce((acc, s) => {
    (acc[s.tier] = acc[s.tier] || []).push(s)
    return acc
  }, {})

  return (
    <div className="flex flex-col min-h-dvh sponsors-page">

      {/* ── Hero 牌匾 ─────────────────────────────────────── */}
      <div className="relative px-4 pt-5 pb-2">
        <button
          onClick={() => navigate(-1)}
          className="text-amber-900/70 text-sm mb-3 active:opacity-70 font-imperial font-bold relative z-10"
        >
          ‹ 返回
        </button>

        <div className="relative max-w-sm mx-auto">
          {/* Hero gold scroll image — 中心橢圓正好放標題 */}
          <img
            src="/sponsors/hero-sponsors.png"
            alt=""
            aria-hidden
            className="w-full block select-none pointer-events-none"
            draggable={false}
          />

          {/* 品牌朱印 — 蓋在 hero 圖 AI 生成的假印上 */}
          <div className="brand-seal" aria-hidden>
            <span>醫</span>
            <span>路</span>
            <span>相</span>
            <span>挺</span>
          </div>

          {/* 標題 overlay 對齊圖中橢圓 */}
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <p className="font-imperial text-[9px] tracking-[0.6em] text-amber-900/55 mb-1">
              ─ 共 立 鴻 名 ─
            </p>
            <h1 className="font-imperial font-black text-5xl gold-text leading-none">
              感謝榜
            </h1>
            <p className="font-imperial text-[11px] text-amber-900/65 mt-2">
              諸君 · 同立此榜
            </p>
          </div>
        </div>

        <p className="text-center text-stone-600 text-xs font-imperial mt-3 leading-relaxed px-4">
          感謝以下諸君慷慨襄助<br />
          讓平台得以持續維運<br />
          為後來者點亮一盞燈
        </p>
      </div>

      {/* ── 主內容 ────────────────────────────────────────── */}
      <div className="px-4 py-2 flex-1">
        {loading && (
          <p className="text-center text-stone-400 py-12 font-imperial">榜上敬載中…</p>
        )}

        {err && (
          <p className="text-center text-red-700 py-10 font-imperial">{err}</p>
        )}

        {!loading && !err && sponsors.length === 0 && (
          <div className="relative my-6 mx-auto max-w-md">
            <div className="diamond-card">
              <div className="diamond-card-inner py-8 text-center relative z-10">
                <div className="text-5xl mb-3">🌅</div>
                <p className="font-imperial text-xl font-bold gold-text mb-2">
                  首位上榜 · 等你揭幕
                </p>
                <p className="text-sm text-stone-600 mb-5 leading-relaxed font-imperial">
                  凡有心人皆可上榜<br />
                  匿名或具名 一份心意便足
                </p>
                <a
                  href={ECPAY_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="gold-cta"
                >
                  ☕ 立刻贊助上榜
                </a>
              </div>
            </div>
          </div>
        )}

        {!loading && !err && sponsors.length > 0 && (
          <>
            {TIER_ORDER.map(t => {
              const list = byTier[t]
              if (!list || list.length === 0) return null
              const meta = TIER_META[t]
              return (
                <section key={t}>
                  <TierDivider meta={meta} count={list.length} />
                  <div className="space-y-2.5">
                    {list.map((s, i) => (
                      <SponsorCard key={`${t}-${i}`} sponsor={s} tier={t} />
                    ))}
                  </div>
                </section>
              )
            })}

            {/* 底部 CTA */}
            <div className="mt-10 mb-4">
              <div className="diamond-card">
                <div className="diamond-card-inner py-6 px-5 text-center relative z-10">
                  <p className="font-imperial text-lg font-bold gold-text mb-1">
                    你也想留名此榜？
                  </p>
                  <p className="text-xs text-stone-600 mb-4 leading-relaxed font-imperial">
                    贊助任意金額皆可<br />
                    1-2 天內由站長親自將芳名敬錄此榜
                  </p>
                  <a
                    href={ECPAY_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="gold-cta"
                  >
                    ☕ 用綠界贊助 ›
                  </a>
                  <p className="text-[10px] text-stone-400 mt-3 font-imperial">
                    自訂顯示名稱 或 匿名
                  </p>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      <Footer />
    </div>
  )
}
