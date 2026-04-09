import React, { useState, useEffect } from 'react'

/* ── SVG Logo mark ──────────────────────────────────────────────── */
function LogoMark() {
  return (
    <svg width="148" height="160" viewBox="0 0 148 160" fill="none"
         xmlns="http://www.w3.org/2000/svg" className="mx-auto">
      <defs>
        <linearGradient id="circleFill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#1A6B9A" />
          <stop offset="100%" stopColor="#0D9488" />
        </linearGradient>
        <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="shadow" x="-15%" y="-10%" width="130%" height="140%">
          <feDropShadow dx="0" dy="6" stdDeviation="10" floodColor="#000" floodOpacity="0.35" />
        </filter>
      </defs>

      {/* Outer glow ring */}
      <circle cx="74" cy="98" r="62" fill="rgba(26,107,154,0.18)" />

      {/* Main circle */}
      <circle cx="74" cy="95" r="58" fill="url(#circleFill)" filter="url(#shadow)" />

      {/* Circle border */}
      <circle cx="74" cy="95" r="58" stroke="rgba(255,255,255,0.22)" strokeWidth="1.5" fill="none" />

      {/* Inner subtle ring */}
      <circle cx="74" cy="95" r="50" stroke="rgba(255,255,255,0.08)" strokeWidth="1" fill="none" />

      {/* Medical cross — vertical bar */}
      <rect x="60" y="62" width="28" height="66" rx="7" fill="white" />

      {/* Medical cross — horizontal bar */}
      <rect x="41" y="81" width="66" height="28" rx="7" fill="white" />

      {/* Cross intersection teal tint */}
      <rect x="60" y="81" width="28" height="28" rx="5" fill="rgba(13,148,136,0.12)" />

      {/* ── Crown ── */}
      {/* Crown body points */}
      <path
        d="M 40 52 L 48 34 L 60 44 L 74 24 L 88 44 L 100 34 L 108 52 Z"
        fill="#F59E0B"
      />
      {/* Crown base band */}
      <rect x="39" y="50" width="70" height="9" rx="4" fill="#F59E0B" />

      {/* Crown highlight top edge */}
      <rect x="39" y="50" width="70" height="3" rx="2" fill="#FCD34D" opacity="0.6" />

      {/* Crown jewels */}
      <circle cx="74" cy="27" r="5"   fill="#FDE68A" />
      <circle cx="74" cy="27" r="3"   fill="#FCD34D" />
      <circle cx="49" cy="36" r="3.5" fill="#FDE68A" />
      <circle cx="49" cy="36" r="2"   fill="#FCD34D" />
      <circle cx="99" cy="36" r="3.5" fill="#FDE68A" />
      <circle cx="99" cy="36" r="2"   fill="#FCD34D" />

      {/* Crown gem shine dots */}
      <circle cx="75.5" cy="25.5" r="1" fill="white" opacity="0.8" />
      <circle cx="50"   cy="35"   r="0.8" fill="white" opacity="0.7" />
      <circle cx="100"  cy="35"   r="0.8" fill="white" opacity="0.7" />
    </svg>
  )
}

/* ── Splash screen ──────────────────────────────────────────────── */
export default function SplashScreen({ onDone }) {
  const [phase, setPhase] = useState('in') // 'in' → 'hold' → 'out'

  useEffect(() => {
    // in: 0–700ms (CSS transition handles it)
    // hold: 700–2300ms
    // out: 2300–2800ms → call onDone
    const t1 = setTimeout(() => setPhase('out'), 2300)
    const t2 = setTimeout(onDone, 2800)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [])

  const skip = () => {
    setPhase('out')
    setTimeout(onDone, 500)
  }

  return (
    <div
      onClick={skip}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center select-none"
      style={{
        background: 'linear-gradient(160deg, #0F2A3F 0%, #1A6B9A 55%, #0D9488 100%)',
        opacity: phase === 'out' ? 0 : 1,
        transition: phase === 'out' ? 'opacity 0.5s ease-in' : 'none',
      }}
    >
      {/* Background ✚ decorations */}
      {[...Array(9)].map((_, i) => (
        <div key={i}
             className="absolute text-white/[0.04] font-bold select-none pointer-events-none"
             style={{ fontSize: 90, top: `${4 + i * 22}%`, left: `${-8 + (i % 3) * 42}%` }}>
          ✚
        </div>
      ))}

      {/* Logo + text block */}
      <div
        className="flex flex-col items-center"
        style={{
          opacity: phase === 'in' ? 0 : 1,
          transform: phase === 'in' ? 'scale(0.82) translateY(12px)' : 'scale(1) translateY(0)',
          transition: 'opacity 0.65s ease-out, transform 0.65s cubic-bezier(0.34, 1.4, 0.64, 1)',
          // Trigger reflow so animation plays: start hidden, then browser paints the transition
          animation: 'none',
        }}
        // Force 'in' → immediate 'hold' render after mount
        ref={el => { if (el && phase === 'in') requestAnimationFrame(() => setPhase('hold')) }}
      >
        <LogoMark />

        <div className="text-center mt-5">
          <h1 className="text-white font-bold tracking-tight leading-none"
              style={{ fontSize: 38, letterSpacing: '-0.02em' }}>
            國考知識王
          </h1>
          <p className="text-white/45 text-sm mt-2 tracking-[0.18em]">
            醫師一階國考 · 即時對戰
          </p>
        </div>

        {/* Loading dots */}
        <div className="flex gap-2 mt-10">
          {[0, 1, 2].map(i => (
            <div key={i}
                 className="w-1.5 h-1.5 rounded-full bg-white/30 animate-bounce"
                 style={{ animationDelay: `${i * 0.18}s` }} />
          ))}
        </div>
      </div>

      {/* Skip hint */}
      <p className="absolute bottom-14 text-white/20 text-xs tracking-widest">
        點擊任意處跳過
      </p>
    </div>
  )
}
