import { useState, useRef, useEffect, useCallback } from 'react'

/*
 * 全螢幕圖片檢視器 — 題目附圖與選項圖共用。
 *
 * 為什麼需要反轉／對比：題庫裡大量是 X 光、心電圖、病理切片、眼底照，
 * 在手機上常常整張偏黑或偏白，原本只能點開放大、看不清細節。
 * 美國醫師國考（NBME）2026 的考試介面就內建反轉顏色／對比／縮放，
 * 這是零成本就能補上的（純 CSS filter，不動題庫資料）。
 *
 * 反轉與對比會記在 localStorage：需要反轉看片的人不必每題重按一次。
 * 縮放刻意不記——每張圖大小不同，沿用上一張的倍率只會讓人困惑。
 */

const CONTRAST = [1, 1.4, 1.8]        // 對比三段，循環切換
const PREF_KEY = 'imgViewPrefs'
const MAX_SCALE = 5

function loadPrefs() {
  try {
    const v = JSON.parse(localStorage.getItem(PREF_KEY) || '{}')
    return { invert: !!v.invert, ci: Number.isInteger(v.ci) && v.ci < CONTRAST.length ? v.ci : 0 }
  } catch { return { invert: false, ci: 0 } }   // 私密模式／封鎖 site data 會丟例外
}

export default function ImageLightbox({ src, alt = '放大圖片', onClose }) {
  const init = loadPrefs()
  const [invert, setInvert] = useState(init.invert)
  const [ci, setCi] = useState(init.ci)
  const [scale, setScale] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })

  // 換圖時把縮放與位移歸零（反轉／對比保留）
  useEffect(() => { setScale(1); setPan({ x: 0, y: 0 }) }, [src])

  useEffect(() => {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ invert, ci })) } catch { /* 寫不進去就算了 */ }
  }, [invert, ci])

  // Esc 關閉（桌機）
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const pts = useRef(new Map())        // pointerId → {x,y}
  const gesture = useRef(null)         // 捏合起點：{dist, scale} ／ 拖曳起點：{x,y,pan}

  const clampPan = useCallback((p, s) => {
    // 縮放倍率越大才允許拖越遠，避免把圖拖出畫面外找不回來
    const lim = Math.max(0, (s - 1) * 260)
    return { x: Math.max(-lim, Math.min(lim, p.x)), y: Math.max(-lim, Math.min(lim, p.y)) }
  }, [])

  const setScaleAt = useCallback(s => {
    const ns = Math.max(1, Math.min(MAX_SCALE, s))
    setScale(ns)
    setPan(p => (ns === 1 ? { x: 0, y: 0 } : clampPan(p, ns)))
  }, [clampPan])

  const onDown = e => {
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const list = [...pts.current.values()]
    if (list.length === 2) {
      const d = Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y)
      gesture.current = { kind: 'pinch', dist: d, scale }
    } else if (list.length === 1 && scale > 1) {
      gesture.current = { kind: 'drag', x: e.clientX, y: e.clientY, pan }
    }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  const onMove = e => {
    if (!pts.current.has(e.pointerId)) return
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    if (!g) return
    const list = [...pts.current.values()]
    if (g.kind === 'pinch' && list.length === 2) {
      const d = Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y)
      if (g.dist > 0) setScaleAt(g.scale * (d / g.dist))
    } else if (g.kind === 'drag') {
      setPan(clampPan({ x: g.pan.x + (e.clientX - g.x), y: g.pan.y + (e.clientY - g.y) }, scale))
    }
  }

  const onUp = e => {
    pts.current.delete(e.pointerId)
    if (pts.current.size < 2) gesture.current = null
  }

  // 連點兩下：1 ⇄ 2.5 倍
  const lastTap = useRef(0)
  const onImgClick = e => {
    e.stopPropagation()
    const now = Date.now()
    if (now - lastTap.current < 300) { setScaleAt(scale > 1 ? 1 : 2.5); lastTap.current = 0 }
    else lastTap.current = now
  }

  const filter = `invert(${invert ? 1 : 0}) contrast(${CONTRAST[ci]})`
  const btn = 'px-3 py-2 rounded-xl text-xs font-semibold active:scale-95 transition-all'

  return (
    <div
      className="fixed inset-0 z-[120] bg-black flex flex-col items-center justify-center"
      onClick={() => onClose?.()}
    >
      <div
        className="flex-1 w-full flex items-center justify-center overflow-hidden p-4"
        style={{ touchAction: 'none' }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          onClick={onImgClick}
          className="max-w-full max-h-full rounded-xl bg-white p-2 shadow-2xl select-none"
          style={{
            filter,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            transition: gesture.current ? 'none' : 'transform 120ms ease-out',
            cursor: scale > 1 ? 'grab' : 'zoom-in',
          }}
        />
      </div>

      {/* 工具列 */}
      <div
        className="w-full px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 flex items-center justify-center gap-2 flex-wrap"
        onClick={e => e.stopPropagation()}
      >
        <button type="button" className={`${btn} bg-white/15 text-white`}
                onClick={() => setScaleAt(scale - 0.5)} disabled={scale <= 1}
                style={{ opacity: scale <= 1 ? 0.4 : 1 }} aria-label="縮小">−</button>
        <span className="text-white/70 text-xs font-mono w-10 text-center">{scale.toFixed(1)}×</span>
        <button type="button" className={`${btn} bg-white/15 text-white`}
                onClick={() => setScaleAt(scale + 0.5)} disabled={scale >= MAX_SCALE}
                style={{ opacity: scale >= MAX_SCALE ? 0.4 : 1 }} aria-label="放大">＋</button>

        <button type="button"
                className={`${btn} ${invert ? 'bg-white text-gray-900' : 'bg-white/15 text-white'}`}
                onClick={() => setInvert(v => !v)}>反轉</button>
        <button type="button"
                className={`${btn} ${ci ? 'bg-white text-gray-900' : 'bg-white/15 text-white'}`}
                onClick={() => setCi(i => (i + 1) % CONTRAST.length)}>
          對比{ci ? ` ${ci + 1}` : ''}
        </button>
        <button type="button" className={`${btn} bg-white/15 text-white`}
                onClick={() => { setScaleAt(1); setInvert(false); setCi(0) }}>重設</button>
        <button type="button" className={`${btn} bg-white/15 text-white`}
                onClick={() => onClose?.()}>關閉</button>
      </div>
      <p className="text-white/40 text-[10px] pb-2">可雙指縮放、連點兩下放大；拖曳可移動</p>
    </div>
  )
}
