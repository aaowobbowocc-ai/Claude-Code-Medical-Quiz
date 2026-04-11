import { useEffect, useState } from 'react'

const COINS = Array.from({ length: 8 }, (_, i) => ({
  id: i,
  delay: i * 80,
  x: (Math.random() - 0.5) * 120,
  y: -60 - Math.random() * 40,
}))

export default function CoinAnimation({ onDone }) {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const t = setTimeout(() => { setVisible(false); onDone?.() }, 1200)
    return () => clearTimeout(t)
  }, [onDone])

  if (!visible) return null

  return (
    <div className="fixed inset-0 z-50 pointer-events-none overflow-hidden">
      {COINS.map(c => (
        <span
          key={c.id}
          className="absolute text-2xl"
          style={{
            left: '50%',
            top: '50%',
            animation: `coinFly 1s ease-out ${c.delay}ms forwards`,
            '--tx': `${c.x}px`,
            '--ty': `${c.y}px`,
            opacity: 0,
          }}
        >
          🪙
        </span>
      ))}
      <style>{`
        @keyframes coinFly {
          0% { transform: translate(-50%, 0) scale(0.5); opacity: 0; }
          20% { opacity: 1; transform: translate(calc(-50% + var(--tx) * 0.3), calc(var(--ty) * 0.3)) scale(1.2); }
          100% { opacity: 0; transform: translate(calc(-50% + var(--tx)), var(--ty)) scale(0.3); }
        }
      `}</style>
    </div>
  )
}
