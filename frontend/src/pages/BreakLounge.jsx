import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import Footer from '../components/Footer'

/**
 * 站長雜貨抽獎 — 讀書讀累了，抽一間店/一個商品來看看？
 * Tab 切換：抽商店 (shops) / 抽商品 (products)。
 * 隨機 3 種動畫：扭蛋 / 翻牌 / 福袋。無 cooldown。
 */

const ANIM_MODES = ['gacha', 'cards', 'fukubukuro', 'chest', 'slot']

const ANIM_DURATION = {
  gacha:       3200,
  cards:       1800,
  fukubukuro:  2700,
  chest:       2600,
  slot:        2800,
}

export default function BreakLounge() {
  const navigate = useNavigate()
  const [shopsData, setShopsData] = useState(null)
  const [productsData, setProductsData] = useState(null)
  const [poolType, setPoolType] = useState('shops')  // shops | products
  const [phase, setPhase] = useState('idle')          // idle | spinning | revealed
  const [mode, setMode] = useState('gacha')           // gacha | cards | fukubukuro
  const [picked, setPicked] = useState(null)

  useEffect(() => {
    fetch('/break-lounge.json', { cache: 'no-cache' })
      .then(r => r.json())
      .then(setShopsData)
      .catch(() => setShopsData({ sections: [] }))
    fetch('/break-lounge-products.json', { cache: 'no-cache' })
      .then(r => r.ok ? r.json() : { sections: [] })
      .then(setProductsData)
      .catch(() => setProductsData({ sections: [] }))
  }, [])

  const shopsPool = useMemo(
    () => shopsData ? shopsData.sections.flatMap(s => s.products) : [],
    [shopsData]
  )
  const productsPool = useMemo(
    () => productsData ? productsData.sections.flatMap(s => s.products) : [],
    [productsData]
  )
  const pool = poolType === 'shops' ? shopsPool : productsPool

  const spin = useCallback(() => {
    if (!pool.length || phase === 'spinning') return
    const newMode = ANIM_MODES[Math.floor(Math.random() * ANIM_MODES.length)]
    const newPick = pool[Math.floor(Math.random() * pool.length)]
    setMode(newMode)
    setPicked({ ...newPick, _type: poolType })
    setPhase('spinning')
    setTimeout(() => setPhase('revealed'), ANIM_DURATION[newMode] || 3000)
  }, [pool, phase, poolType])

  const reset = () => {
    setPhase('idle')
    setPicked(null)
  }

  const switchPool = (t) => {
    if (phase === 'spinning') return
    setPoolType(t)
    reset()
  }

  const dataReady = shopsData && productsData

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      <div className="grad-header px-5 pt-14 pb-6 relative">
        <button onClick={() => navigate(-1)}
                className="absolute top-4 left-3 text-white/70 text-sm flex items-center gap-1 active:scale-95">
          ← 返回
        </button>
        <h1 className="text-white font-bold text-2xl text-center">🎰 站長雜貨抽獎</h1>
        <p className="text-white/60 text-xs text-center mt-1">讀書讀累了，抽個東西來逛逛？</p>
      </div>

      {/* Tab 切換：商店 / 商品 */}
      {dataReady && (
        <div className="px-4 pt-4">
          <div className="flex bg-white rounded-xl p-1 shadow-sm max-w-xs mx-auto">
            <button
              onClick={() => switchPool('shops')}
              disabled={!shopsPool.length || phase === 'spinning'}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-40
                ${poolType === 'shops' ? 'bg-orange-400 text-white' : 'text-gray-600'}`}>
              🛍️ 抽商店
              <span className="text-[10px] block opacity-70">{shopsPool.length} 家</span>
            </button>
            <button
              onClick={() => switchPool('products')}
              disabled={!productsPool.length || phase === 'spinning'}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-40
                ${poolType === 'products' ? 'bg-orange-400 text-white' : 'text-gray-600'}`}>
              🎁 抽商品
              <span className="text-[10px] block opacity-70">{productsPool.length} 個</span>
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 px-4 py-6 flex flex-col items-center justify-center min-h-[60vh]">
        {!dataReady && <Loading />}
        {dataReady && phase === 'idle' && (
          pool.length
            ? <Idle onSpin={spin} poolType={poolType} />
            : <Empty poolType={poolType} />
        )}
        {dataReady && phase === 'spinning' && (
          <>
            {mode === 'gacha' && <GachaSpinning />}
            {mode === 'cards' && <CardSpinning />}
            {mode === 'fukubukuro' && <FukubukuroSpinning />}
            {mode === 'chest' && <ChestSpinning />}
            {mode === 'slot' && <SlotSpinning />}
          </>
        )}
        {dataReady && phase === 'revealed' && picked && <Reveal product={picked} onAgain={() => { reset(); setTimeout(spin, 50) }} />}
      </div>

      <div className="text-center text-[11px] text-gray-300 px-5 pb-3">
        放點廣告維持生計，有興趣可以逛逛
      </div>

      <Footer />
    </div>
  )
}

function Empty({ poolType }) {
  return (
    <div className="text-center text-gray-400 text-sm">
      {poolType === 'products' ? '商品池還沒準備好，先試試抽商店吧' : '池子是空的'}
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

function Idle({ onSpin, poolType }) {
  const isShops = poolType === 'shops'
  return (
    <div className="flex flex-col items-center gap-6">
      <div className="text-7xl animate-pulse">{isShops ? '🛍️' : '🎁'}</div>
      <p className="text-gray-500 text-sm">{isShops ? '點下方按鈕，看看會抽到哪一家' : '點下方按鈕，看看會抽到什麼'}</p>
      <button onClick={onSpin}
              className="px-8 py-4 rounded-2xl text-white font-bold text-lg active:scale-95 transition-transform shadow-lg
                         bg-gradient-to-br from-amber-400 via-orange-400 to-pink-400">
        🎲 {isShops ? '來抽一間' : '來抽一個'}
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

/* ── 寶箱動畫 ───────────────────────────── */
// 0-0.9s 抖動 → 0.9-1.5s 鎖頭掉落 → 1.5-2.1s 蓋子打開+光芒 → 2.1-2.6s 寶物飛出
function ChestSpinning() {
  const [stage, setStage] = useState(0)
  useEffect(() => {
    const t1 = setTimeout(() => setStage(1), 900)
    const t2 = setTimeout(() => setStage(2), 1500)
    const t3 = setTimeout(() => setStage(3), 2100)
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, [])
  const coins = useMemo(() => [
    { e: '🪙', cx: '-70px', cy: '-110px', d: '0s' },
    { e: '💰', cx: '60px',  cy: '-130px', d: '0.05s' },
    { e: '💎', cx: '-40px', cy: '-150px', d: '0.1s' },
    { e: '🪙', cx: '80px',  cy: '-90px',  d: '0.15s' },
    { e: '⭐', cx: '0px',   cy: '-160px', d: '0.2s' },
    { e: '✨', cx: '-90px', cy: '-70px',  d: '0.25s' },
    { e: '💎', cx: '50px',  cy: '-50px',  d: '0.3s' },
  ], [])
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative w-48 h-48">
        {stage >= 2 && <RayBurst count={14} />}
        {/* 箱身 */}
        <div className={`absolute bottom-0 left-1/2 -translate-x-1/2 w-40 h-24 rounded-b-xl shadow-xl
          bg-gradient-to-b from-amber-700 via-amber-800 to-amber-900 border-2 border-amber-950
          ${stage === 0 ? 'animate-chest-shake' : ''}
        `}>
          <div className="absolute inset-2 rounded-md border border-amber-500/30" />
          <div className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 w-6 h-8 bg-amber-950 rounded" />
          {stage >= 2 && (
            <div className="absolute inset-x-2 top-0 h-12 rounded-md bg-gradient-to-b from-amber-200 to-yellow-400 shadow-[0_0_30px_rgba(251,191,36,0.9)]" />
          )}
        </div>
        {/* 蓋子（旋轉打開） */}
        <div className={`absolute left-1/2 -translate-x-1/2 w-40 h-12 rounded-t-xl
          bg-gradient-to-b from-amber-600 to-amber-800 border-2 border-amber-950 shadow-lg origin-bottom
          ${stage === 0 ? 'animate-chest-shake' : ''}
          ${stage >= 2 ? 'animate-chest-lid-open' : ''}
        `}
        style={{ bottom: '96px', transformStyle: 'preserve-3d' }}>
          <div className="absolute inset-1 rounded-t-md border border-amber-400/30" />
        </div>
        {/* 鎖頭 */}
        {stage < 1 && (
          <div className={`absolute left-1/2 w-8 h-8 -translate-x-1/2
            bg-gradient-to-br from-yellow-300 to-amber-500 rounded border-2 border-amber-800 animate-glow-pulse
          `} style={{ bottom: '92px' }}>
            <div className="absolute -top-2 left-1/2 -translate-x-1/2 w-4 h-3 border-2 border-amber-800 rounded-t-full bg-transparent" />
          </div>
        )}
        {stage === 1 && (
          <div className="absolute left-1/2 w-8 h-8 bg-gradient-to-br from-yellow-300 to-amber-500 rounded border-2 border-amber-800 animate-chest-lock-fall"
               style={{ bottom: '92px' }}>
            <div className="absolute -top-2 left-1/2 -translate-x-1/2 w-4 h-3 border-2 border-amber-800 rounded-t-full bg-transparent" />
          </div>
        )}
        {stage >= 3 && coins.map((c, i) => (
          <span key={i}
                className="absolute left-1/2 bottom-12 text-2xl animate-coin-fly pointer-events-none"
                style={{ '--cx': c.cx, '--cy': c.cy, animationDelay: c.d }}>
            {c.e}
          </span>
        ))}
      </div>
      <p className="text-gray-500 text-sm">
        {stage === 0 && '寶箱在抖…'}
        {stage === 1 && '咔！鎖掉了'}
        {stage === 2 && '咿呀—打開了'}
        {stage === 3 && '寶物飛出來了！'}
      </p>
    </div>
  )
}

/* ── 老虎機動畫 ─────────────────────────── */
function SlotSpinning() {
  const [r1, setR1] = useState(false)
  const [r2, setR2] = useState(false)
  const [r3, setR3] = useState(false)
  const [done, setDone] = useState(false)
  useEffect(() => {
    const t1 = setTimeout(() => setR1(true), 1200)
    const t2 = setTimeout(() => setR2(true), 1800)
    const t3 = setTimeout(() => setR3(true), 2400)
    const t4 = setTimeout(() => setDone(true), 2500)
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4) }
  }, [])
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative w-64 p-4 rounded-3xl bg-gradient-to-b from-rose-500 to-rose-700 shadow-2xl border-4 border-rose-900">
        {done && <div className="absolute -inset-1 rounded-3xl pointer-events-none animate-slot-flash bg-yellow-300/30" />}
        <div className="text-center text-yellow-200 font-black tracking-widest text-sm mb-2 drop-shadow">★ JACKPOT ★</div>
        <div className="flex gap-1.5 bg-black/40 p-2 rounded-xl">
          <Reel stopped={r1} symbols={['🍒','🍋','7️⃣','💎','🔔','🍀']} pick="💎" />
          <Reel stopped={r2} symbols={['🔔','🍀','🍒','7️⃣','💎','🍋']} pick="💎" />
          <Reel stopped={r3} symbols={['7️⃣','💎','🍋','🍒','🔔','🍀']} pick="💎" />
        </div>
        {/* 拉桿 */}
        <div className="absolute -right-3 top-1/2 -translate-y-1/2 w-2 h-20 bg-gradient-to-b from-gray-300 to-gray-600 rounded-full">
          <div className="absolute -top-2 -left-1.5 w-5 h-5 rounded-full bg-gradient-to-br from-red-400 to-red-700 border border-red-900" />
        </div>
        <div className="flex justify-around mt-3">
          {[0,1,2,3,4].map(i => (
            <span key={i} className={`w-2 h-2 rounded-full ${done ? 'bg-yellow-300 animate-pulse' : 'bg-yellow-400/50'}`}
                  style={{ animationDelay: `${i * 0.1}s` }} />
          ))}
        </div>
      </div>
      <p className="text-gray-500 text-sm">
        {!r1 ? '轉啊轉…' : !r3 ? '快停了…' : done ? '🎉 BINGO！' : ''}
      </p>
    </div>
  )
}

function Reel({ stopped, symbols, pick }) {
  return (
    <div className="relative w-14 h-20 bg-white rounded-md overflow-hidden border-2 border-yellow-300 shadow-inner">
      {!stopped && (
        <div className="absolute inset-x-0 animate-slot-fast">
          {[...symbols, ...symbols].map((s, i) => (
            <div key={i} className="h-20 flex items-center justify-center text-3xl">{s}</div>
          ))}
        </div>
      )}
      {stopped && (
        <div className="absolute inset-0 flex items-center justify-center text-3xl animate-slot-stop">{pick}</div>
      )}
      <div className="absolute inset-x-0 top-0 h-1/3 bg-gradient-to-b from-white/60 to-transparent pointer-events-none" />
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/20 to-transparent pointer-events-none" />
    </div>
  )
}

/* ── 通用：光芒射線 ─────────────────────── */
function RayBurst({ count = 10, color = 'from-amber-200/0 via-amber-300/80 to-amber-200/0' }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none animate-ray-burst">
      {Array.from({ length: count }).map((_, i) => (
        <span key={i}
              className={`absolute w-1 h-32 bg-gradient-to-b ${color} rounded-full origin-bottom`}
              style={{ transform: `rotate(${(360 / count) * i}deg) translateY(-50%)` }} />
      ))}
    </div>
  )
}

/* ── Reveal: 統一的揭曉卡片（含 shimmer 光帶 + 雙星裝飾）─── */
function Reveal({ product, onAgain }) {
  const isProduct = product._type === 'products'
  return (
    <div className="w-full max-w-sm flex flex-col items-center gap-4 animate-reveal-pop">
      <div className="relative">
        <p className="text-gray-500 text-sm">叮咚 — 你抽到的是</p>
        <span className="absolute -top-2 -left-3 text-lg animate-sparkle">✨</span>
        <span className="absolute -top-2 -right-3 text-lg animate-sparkle" style={{ animationDelay: '0.3s' }}>✨</span>
      </div>
      <a href={product.shopUrl} target="_blank" rel="noopener noreferrer sponsored"
         className="relative block w-full bg-white rounded-3xl p-5 shadow-xl border-2 border-orange-200 active:scale-[0.99] overflow-hidden">
        <span className="pointer-events-none absolute inset-0 -translate-x-full animate-shimmer
                         bg-gradient-to-r from-transparent via-white/60 to-transparent" />
        {product.image && (
          <img src={product.image} alt={product.name}
               className="w-full aspect-square object-cover rounded-2xl mb-3 bg-gray-100"
               loading="lazy" />
        )}
        <h2 className="relative text-lg font-bold text-gray-800 text-center break-words">{product.name}</h2>
        {product.price && (
          <p className="relative text-center text-orange-600 font-bold mt-2">{product.price}</p>
        )}
        <div className="relative mt-4 px-4 py-2.5 rounded-xl bg-gradient-to-r from-orange-400 to-amber-400 text-white text-center font-semibold text-sm shadow">
          {product.ctaText || (isProduct ? '看看這個商品' : '進入店家頁面')} →
        </div>
      </a>
      <button onClick={onAgain}
              className="text-sm text-gray-500 hover:text-gray-700 underline underline-offset-4">
        🔄 再抽一次
      </button>
    </div>
  )
}
