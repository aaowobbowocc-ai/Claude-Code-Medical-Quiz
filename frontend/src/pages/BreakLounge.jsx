import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import Footer from '../components/Footer'

/**
 * 站長雜貨抽獎 — 讀書讀累了，抽一間店來逛逛？
 * 隨機 3 種動畫：扭蛋 / 翻牌 / 福袋。
 * 商品 pool 從 /break-lounge.json 載入，flatten 所有 sections.products。
 * 無 cooldown，可一直抽。
 */

const ANIM_MODES = ['gacha', 'cards', 'fukubukuro']

export default function BreakLounge() {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [phase, setPhase] = useState('idle')   // idle | spinning | revealed
  const [mode, setMode] = useState('gacha')    // gacha | cards | fukubukuro
  const [picked, setPicked] = useState(null)

  useEffect(() => {
    fetch('/break-lounge.json', { cache: 'no-cache' })
      .then(r => r.json())
      .then(setData)
      .catch(() => setData({ sections: [] }))
  }, [])

  // Flat product pool with section context
  const pool = useMemo(() => {
    if (!data) return []
    const out = []
    for (const s of data.sections) {
      for (const p of s.products) {
        out.push({ ...p, sectionTitle: s.title, sectionIcon: s.icon })
      }
    }
    return out
  }, [data])

  const spin = useCallback(() => {
    if (!pool.length || phase === 'spinning') return
    const newMode = ANIM_MODES[Math.floor(Math.random() * ANIM_MODES.length)]
    const newPick = pool[Math.floor(Math.random() * pool.length)]
    setMode(newMode)
    setPicked(newPick)
    setPhase('spinning')
    // Animation duration depends on mode
    const duration = newMode === 'cards' ? 900 : newMode === 'fukubukuro' ? 1800 : 2200
    setTimeout(() => setPhase('revealed'), duration)
  }, [pool, phase])

  const reset = () => {
    setPhase('idle')
    setPicked(null)
  }

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      <div className="grad-header px-5 pt-14 pb-6 relative">
        <button onClick={() => navigate(-1)}
                className="absolute top-4 left-3 text-white/70 text-sm flex items-center gap-1 active:scale-95">
          ← 返回
        </button>
        <h1 className="text-white font-bold text-2xl text-center">🎰 站長雜貨抽獎</h1>
        <p className="text-white/60 text-xs text-center mt-1">讀書讀累了，抽一間店來逛逛？</p>
      </div>

      <div className="flex-1 px-4 py-6 flex flex-col items-center justify-center min-h-[60vh]">
        {!data && <Loading />}
        {data && phase === 'idle' && <Idle onSpin={spin} />}
        {data && phase === 'spinning' && (
          <>
            {mode === 'gacha' && <GachaSpinning />}
            {mode === 'cards' && <CardSpinning />}
            {mode === 'fukubukuro' && <FukubukuroSpinning />}
          </>
        )}
        {data && phase === 'revealed' && picked && <Reveal product={picked} onAgain={() => { reset(); setTimeout(spin, 50) }} />}
      </div>

      <div className="text-center text-[11px] text-gray-300 px-5 pb-3">
        放點廣告維持生計，有興趣可以逛逛
      </div>

      <Footer />
    </div>
  )
}

function Loading() {
  return (
    <div className="flex gap-1.5 py-2">
      {[0,1,2].map(i => (
        <span key={i} className="w-2.5 h-2.5 rounded-full bg-gray-300 animate-bounce"
              style={{ animationDelay: `${i * 0.15}s` }} />
      ))}
    </div>
  )
}

function Idle({ onSpin }) {
  return (
    <div className="flex flex-col items-center gap-6">
      <div className="text-7xl animate-pulse">🎁</div>
      <p className="text-gray-500 text-sm">點下方按鈕，看看會抽到哪一家</p>
      <button onClick={onSpin}
              className="px-8 py-4 rounded-2xl text-white font-bold text-lg active:scale-95 transition-transform shadow-lg
                         bg-gradient-to-br from-amber-400 via-orange-400 to-pink-400">
        🎲 來抽一間
      </button>
    </div>
  )
}

/* ── 扭蛋機動畫 ─────────────────────────────── */
function GachaSpinning() {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative w-44 h-52">
        {/* Machine body */}
        <div className="absolute inset-0 bg-gradient-to-br from-rose-300 to-rose-500 rounded-3xl shadow-xl gacha-shake" />
        {/* Glass dome with balls */}
        <div className="absolute top-3 left-3 right-3 h-28 bg-white/40 rounded-2xl backdrop-blur overflow-hidden border-2 border-white/60">
          {['🔴','🟢','🔵','🟡','🟣','🟠'].map((b, i) => (
            <span key={i} className="absolute text-2xl gacha-ball"
                  style={{
                    left: `${10 + (i * 18) % 70}%`,
                    top: `${20 + (i * 23) % 60}%`,
                    animationDelay: `${i * 0.1}s`,
                  }}>{b}</span>
          ))}
        </div>
        {/* Slot */}
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-12 h-3 bg-rose-700 rounded-full" />
        {/* Knob */}
        <div className="absolute right-2 top-1/2 w-6 h-6 bg-amber-300 rounded-full border-2 border-amber-600 gacha-knob" />
      </div>
      <p className="text-gray-500 text-sm">扭蛋中…</p>
      <style>{`
        @keyframes gachaShake {
          0%, 100% { transform: rotate(0); }
          25% { transform: rotate(-2deg); }
          75% { transform: rotate(2deg); }
        }
        @keyframes gachaBall {
          0%, 100% { transform: translate(0,0); }
          25% { transform: translate(8px, -10px); }
          50% { transform: translate(-6px, 8px); }
          75% { transform: translate(10px, 4px); }
        }
        @keyframes gachaKnob {
          from { transform: rotate(0); }
          to { transform: rotate(720deg); }
        }
        .gacha-shake { animation: gachaShake 0.4s ease-in-out infinite; }
        .gacha-ball { animation: gachaBall 0.6s ease-in-out infinite; }
        .gacha-knob { animation: gachaKnob 1.2s linear infinite; }
      `}</style>
    </div>
  )
}

/* ── 翻牌動畫 ─────────────────────────────── */
function CardSpinning() {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex gap-3">
        {[0,1,2,3].map(i => (
          <div key={i} className="w-16 h-24 rounded-xl bg-gradient-to-br from-purple-400 to-indigo-600 shadow-lg flex items-center justify-center text-3xl border-2 border-white/40 card-shuffle"
               style={{ animationDelay: `${i * 0.15}s` }}>
            <span className="text-white/80">?</span>
          </div>
        ))}
      </div>
      <p className="text-gray-500 text-sm">洗牌中…</p>
      <style>{`
        @keyframes cardShuffle {
          0%, 100% { transform: translateY(0) rotate(0); }
          50% { transform: translateY(-15px) rotate(-5deg); }
        }
        .card-shuffle { animation: cardShuffle 0.5s ease-in-out infinite; }
      `}</style>
    </div>
  )
}

/* ── 福袋動畫 ─────────────────────────────── */
function FukubukuroSpinning() {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative w-32 h-32">
        <div className="absolute inset-0 fukubukuro-shake text-7xl flex items-center justify-center">🎁</div>
        <div className="absolute inset-0 fukubukuro-sparkle text-3xl flex items-center justify-center pointer-events-none">
          <span className="absolute -top-1 left-2">✨</span>
          <span className="absolute top-3 -right-1">⭐</span>
          <span className="absolute -bottom-1 right-3">✨</span>
          <span className="absolute bottom-2 -left-2">⭐</span>
        </div>
      </div>
      <p className="text-gray-500 text-sm">福袋裡藏著什麼…</p>
      <style>{`
        @keyframes fukubukuroShake {
          0%, 100% { transform: translateY(0) rotate(0); }
          20% { transform: translateY(-10px) rotate(-8deg); }
          40% { transform: translateY(0) rotate(6deg); }
          60% { transform: translateY(-6px) rotate(-4deg); }
          80% { transform: translateY(0) rotate(2deg); }
        }
        @keyframes fukubukuroSparkle {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1.2); }
        }
        .fukubukuro-shake { animation: fukubukuroShake 0.5s ease-in-out infinite; }
        .fukubukuro-sparkle { animation: fukubukuroSparkle 1s ease-in-out infinite; }
      `}</style>
    </div>
  )
}

/* ── Reveal: 統一的揭曉卡片 ─────────────────── */
function Reveal({ product, onAgain }) {
  return (
    <div className="w-full max-w-sm flex flex-col items-center gap-4 reveal-pop">
      <p className="text-gray-500 text-sm">叮咚 — 你抽到的是</p>
      <a href={product.shopUrl} target="_blank" rel="noopener noreferrer sponsored"
         className="block w-full bg-white rounded-3xl p-5 shadow-xl border-2 border-orange-200 active:scale-[0.99]">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xl">{product.sectionIcon}</span>
          <span className="text-xs text-orange-600 font-semibold">{product.sectionTitle}</span>
        </div>
        <h2 className="text-lg font-bold text-gray-800">{product.name}</h2>
        {product.blurb && (
          <p className="text-sm text-gray-600 mt-2 leading-relaxed">{product.blurb}</p>
        )}
        <div className="mt-4 px-4 py-2.5 rounded-xl bg-gradient-to-r from-orange-400 to-amber-400 text-white text-center font-semibold text-sm">
          {product.ctaText || '進入店家頁面'} →
        </div>
      </a>
      <button onClick={onAgain}
              className="text-sm text-gray-500 hover:text-gray-700 underline underline-offset-4">
        🔄 再抽一次
      </button>
      <style>{`
        @keyframes revealPop {
          0% { opacity: 0; transform: scale(0.5) translateY(40px); }
          70% { opacity: 1; transform: scale(1.05) translateY(-4px); }
          100% { opacity: 1; transform: scale(1) translateY(0); }
        }
        .reveal-pop { animation: revealPop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both; }
      `}</style>
    </div>
  )
}
