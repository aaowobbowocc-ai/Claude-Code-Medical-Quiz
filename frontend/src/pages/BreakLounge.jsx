import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
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
    // Total animation duration including all sub-stages
    const duration = newMode === 'cards' ? 1800 : newMode === 'fukubukuro' ? 2700 : 3200
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
// Phases: 0-1.0s 機台搖晃球亂跳 → 1.0-1.8s 一顆球掉下來 → 1.8-2.6s 球滾出來 → 2.6-3.2s 球裂開
function GachaSpinning() {
  const [stage, setStage] = useState(0)
  useEffect(() => {
    const t1 = setTimeout(() => setStage(1), 1000)   // ball drop
    const t2 = setTimeout(() => setStage(2), 1800)   // roll out
    const t3 = setTimeout(() => setStage(3), 2600)   // crack open
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, [])
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative w-56 h-72">
        {/* Machine body — only shake during stage 0 */}
        <div className={`absolute inset-x-0 top-0 h-56 bg-gradient-to-br from-rose-300 to-rose-500 rounded-3xl shadow-xl ${stage === 0 ? 'animate-gacha-shake' : ''}`} />
        {/* Glass dome with bouncing balls */}
        <div className="absolute top-3 left-3 right-3 h-32 bg-white/40 rounded-2xl overflow-hidden border-2 border-white/60">
          {['🔴','🟢','🔵','🟡','🟣','🟠'].map((b, i) => (
            <span key={i} className={`absolute text-2xl ${stage === 0 ? 'animate-gacha-ball' : ''}`}
                  style={{
                    left: `${10 + (i * 18) % 70}%`,
                    top: `${20 + (i * 23) % 60}%`,
                    animationDelay: `${i * 0.1}s`,
                  }}>{b}</span>
          ))}
        </div>
        {/* Slot (出口槽) */}
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 w-14 h-4 bg-rose-700 rounded-full" />
        {/* Knob — turning until ball drops */}
        <div className={`absolute right-2 top-28 w-6 h-6 bg-amber-300 rounded-full border-2 border-amber-600 ${stage <= 1 ? 'animate-gacha-knob' : ''}`} />

        {/* Capsule (the dropping ball) — appears in stage 1, rolls in stage 2, cracks in stage 3 */}
        {stage >= 1 && stage < 3 && (
          <div
            key={`drop-${stage}`}
            className={`absolute left-1/2 w-10 h-10 ${stage === 1 ? 'animate-gacha-drop' : 'animate-gacha-roll'}`}
            style={stage === 2 ? { top: '85%' } : {}}
          >
            <div className="w-full h-full rounded-full bg-gradient-to-br from-yellow-300 to-orange-400 border-2 border-orange-500 shadow-lg" />
          </div>
        )}
        {/* Cracked open at stage 3 — split into two halves flying apart */}
        {stage === 3 && (
          <div className="absolute" style={{ left: '95%', top: '85%', transform: 'translateX(-50%)' }}>
            <div className="relative w-10 h-10">
              <div className="absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-yellow-300 to-orange-400 border-2 border-orange-500 rounded-t-full animate-gacha-crack-top" />
              <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-orange-400 to-yellow-300 border-2 border-orange-500 rounded-b-full animate-gacha-crack-bot" />
              <span className="absolute inset-0 flex items-center justify-center text-2xl animate-pop">✨</span>
            </div>
          </div>
        )}
      </div>
      <p className="text-gray-500 text-sm">
        {stage === 0 && '搖一搖…'}
        {stage === 1 && '掉出來了！'}
        {stage === 2 && '滾出來…'}
        {stage === 3 && '叩—！打開了'}
      </p>
    </div>
  )
}

/* ── 翻牌動畫 ─────────────────────────────── */
// Phases: 0-0.7s 4 張卡洗牌 → 0.7-1.1s 中間那張變大 → 1.1-1.8s 翻面
function CardSpinning() {
  const [stage, setStage] = useState(0)
  useEffect(() => {
    const t1 = setTimeout(() => setStage(1), 700)    // pick center card, scale up
    const t2 = setTimeout(() => setStage(2), 1100)   // flip to reveal
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [])
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex gap-3 items-center" style={{ height: '160px' }}>
        {[0,1,2,3].map(i => {
          const isPicked = i === 1  // arbitrary pick: 2nd card
          if (stage >= 1 && !isPicked) return null  // hide other cards when picking
          return (
            <div
              key={i}
              className={`w-16 h-24 rounded-xl bg-gradient-to-br from-purple-400 to-indigo-600 shadow-lg flex items-center justify-center text-3xl border-2 border-white/40
                ${stage === 0 ? 'animate-card-shuffle' : ''}
                ${stage === 1 && isPicked ? 'animate-card-select' : ''}
                ${stage >= 2 && isPicked ? 'animate-card-flip' : ''}
              `}
              style={{
                animationDelay: stage === 0 ? `${i * 0.15}s` : '0s',
                transformStyle: 'preserve-3d',
              }}
            >
              <span className="text-white/80" style={{ backfaceVisibility: 'hidden' }}>?</span>
              {/* Front side (revealed when flipped) */}
              {stage >= 2 && isPicked && (
                <span
                  className="absolute inset-0 flex items-center justify-center text-3xl bg-gradient-to-br from-amber-200 to-orange-300 rounded-xl border-2 border-orange-400"
                  style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
                >🎁</span>
              )}
            </div>
          )
        })}
      </div>
      <p className="text-gray-500 text-sm">
        {stage === 0 && '洗牌中…'}
        {stage === 1 && '選一張…'}
        {stage === 2 && '翻開！'}
      </p>
    </div>
  )
}

/* ── 福袋動畫 ─────────────────────────────── */
// Phases: 0-1.0s 福袋搖晃 → 1.0-1.5s 袋口打開 → 1.5-2.2s 禮物彈出 + 紙花
function FukubukuroSpinning() {
  const [stage, setStage] = useState(0)
  useEffect(() => {
    const t1 = setTimeout(() => setStage(1), 1000)
    const t2 = setTimeout(() => setStage(2), 1500)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [])
  // Confetti positions (random-ish)
  const confettiItems = useMemo(() => [
    { emoji: '🎉', cx: '60px',  cy: '-80px', delay: '0s' },
    { emoji: '✨', cx: '-50px', cy: '-70px', delay: '0.05s' },
    { emoji: '⭐', cx: '70px',  cy: '-50px', delay: '0.1s' },
    { emoji: '🎊', cx: '-70px', cy: '-50px', delay: '0.15s' },
    { emoji: '💫', cx: '20px',  cy: '-90px', delay: '0.2s' },
    { emoji: '🌟', cx: '-30px', cy: '-90px', delay: '0.25s' },
  ], [])
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative w-40 h-40">
        {/* Bag emoji — shake until open */}
        <div className={`absolute inset-0 text-7xl flex items-center justify-center origin-bottom
          ${stage === 0 ? 'animate-fukubukuro' : ''}
          ${stage === 1 ? 'animate-fukubukuro-open' : ''}
          ${stage === 2 ? 'animate-fukubukuro-open' : ''}
        `}>
          {stage < 1 ? '🎁' : '👜'}
        </div>
        {/* Sparkles around bag */}
        {stage === 0 && (
          <>
            <span className="absolute -top-1 left-6 text-2xl animate-sparkle" style={{ animationDelay: '0s' }}>✨</span>
            <span className="absolute top-6 -right-1 text-2xl animate-sparkle" style={{ animationDelay: '0.3s' }}>⭐</span>
            <span className="absolute -bottom-1 right-6 text-2xl animate-sparkle" style={{ animationDelay: '0.5s' }}>✨</span>
            <span className="absolute bottom-6 -left-1 text-2xl animate-sparkle" style={{ animationDelay: '0.7s' }}>⭐</span>
          </>
        )}
        {/* Item flies up out of bag */}
        {stage >= 2 && (
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-5xl animate-gift-pop">
            🎁
          </div>
        )}
        {/* Confetti */}
        {stage === 2 && confettiItems.map((c, i) => (
          <span
            key={i}
            className="absolute left-1/2 top-1/2 text-xl animate-confetti pointer-events-none"
            style={{
              '--cx': c.cx,
              '--cy': c.cy,
              animationDelay: c.delay,
            }}
          >{c.emoji}</span>
        ))}
      </div>
      <p className="text-gray-500 text-sm">
        {stage === 0 && '福袋搖一搖…'}
        {stage === 1 && '袋口打開了！'}
        {stage === 2 && '出現了！'}
      </p>
    </div>
  )
}

/* ── Reveal: 統一的揭曉卡片 ─────────────────── */
function Reveal({ product, onAgain }) {
  return (
    <div className="w-full max-w-sm flex flex-col items-center gap-4 animate-reveal-pop">
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
    </div>
  )
}
