import React, { useState, useRef, useEffect } from 'react'

/**
 * ReadingModePopover — per-exam reading preferences (line-height, font-size, paragraph gap).
 *
 * Settings are stored in localStorage keyed by exam, so medical vs law exams
 * can have different defaults without interfering.
 *
 * Props:
 *   examId      — active exam id (for localStorage key)
 *   prominent   — true  → gear icon is rendered inline (law exams)
 *                 false → gear icon is smaller / de-emphasized (medical exams)
 */

const STORAGE_PREFIX = 'reading-mode:'

const LINE_HEIGHTS  = [1.5, 1.75, 2.0]
const FONT_SIZES    = ['S', 'M', 'L']
const FONT_PX       = { S: [14, 15], M: [16, 17], L: [18, 19] } // [desktop, mobile]
const PARA_GAPS     = ['tight', 'loose']

const DEFAULT_MEDICAL = { lineHeight: 1.75, fontSize: 'M', paraGap: 'loose' }
const DEFAULT_LEGAL   = { lineHeight: 2.0,  fontSize: 'M', paraGap: 'loose' }

function load(examId) {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_PREFIX + examId))
    if (raw && raw.lineHeight) return raw
  } catch {}
  return null
}

function save(examId, prefs) {
  try { localStorage.setItem(STORAGE_PREFIX + examId, JSON.stringify(prefs)) } catch {}
}

/** Returns the active reading-mode style object to spread onto question containers. */
export function useReadingMode(examId, isLegal = false) {
  const defaults = isLegal ? DEFAULT_LEGAL : DEFAULT_MEDICAL
  const [prefs, setPrefs] = useState(() => load(examId) || defaults)

  // Re-sync when exam changes
  useEffect(() => {
    setPrefs(load(examId) || (isLegal ? DEFAULT_LEGAL : DEFAULT_MEDICAL))
  }, [examId, isLegal])

  const update = (patch) => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    save(examId, next)
  }

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640
  const idx = FONT_SIZES.indexOf(prefs.fontSize)
  const fontPx = idx >= 0 ? (isMobile ? FONT_PX[prefs.fontSize][1] : FONT_PX[prefs.fontSize][0]) : 16

  const style = {
    lineHeight: prefs.lineHeight,
    fontSize: `${fontPx}px`,
    ...(prefs.paraGap === 'loose' ? { marginBottom: '0.75em' } : { marginBottom: '0.25em' }),
  }

  return { prefs, update, style }
}

export default function ReadingModePopover({ examId, prominent = false, prefs, onUpdate }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    document.addEventListener('touchstart', handler)
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('touchstart', handler) }
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`flex items-center justify-center rounded-lg transition-all active:scale-90
          ${prominent
            ? 'w-8 h-8 bg-gray-100 hover:bg-gray-200 text-gray-500'
            : 'w-6 h-6 text-gray-300 hover:text-gray-500'}`}
        title="閱讀設定"
        aria-label="閱讀設定"
      >
        <svg width={prominent ? 18 : 14} height={prominent ? 18 : 14} viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 bg-white rounded-2xl shadow-xl border border-gray-100 p-4 w-56 space-y-3">
          <p className="text-xs font-bold text-gray-600 uppercase tracking-wider">閱讀設定</p>

          {/* Line height */}
          <div>
            <p className="text-[11px] text-gray-400 mb-1">行高</p>
            <div className="flex gap-1.5">
              {LINE_HEIGHTS.map(lh => (
                <button key={lh}
                  onClick={() => onUpdate({ lineHeight: lh })}
                  className={`flex-1 text-xs py-1.5 rounded-lg font-semibold transition-all
                    ${prefs.lineHeight === lh ? 'bg-medical-blue text-white' : 'bg-gray-50 text-gray-500 hover:bg-gray-100'}`}>
                  {lh}
                </button>
              ))}
            </div>
          </div>

          {/* Font size */}
          <div>
            <p className="text-[11px] text-gray-400 mb-1">字級</p>
            <div className="flex gap-1.5">
              {FONT_SIZES.map(fs => (
                <button key={fs}
                  onClick={() => onUpdate({ fontSize: fs })}
                  className={`flex-1 text-xs py-1.5 rounded-lg font-semibold transition-all
                    ${prefs.fontSize === fs ? 'bg-medical-blue text-white' : 'bg-gray-50 text-gray-500 hover:bg-gray-100'}`}>
                  {fs}
                </button>
              ))}
            </div>
          </div>

          {/* Paragraph gap */}
          <div>
            <p className="text-[11px] text-gray-400 mb-1">段落間距</p>
            <div className="flex gap-1.5">
              {PARA_GAPS.map(pg => (
                <button key={pg}
                  onClick={() => onUpdate({ paraGap: pg })}
                  className={`flex-1 text-xs py-1.5 rounded-lg font-semibold transition-all
                    ${prefs.paraGap === pg ? 'bg-medical-blue text-white' : 'bg-gray-50 text-gray-500 hover:bg-gray-100'}`}>
                  {pg === 'tight' ? '緊湊' : '寬鬆'}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
