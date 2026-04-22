import React, { useState } from 'react'

/**
 * Share a challenge link after a practice/mock/PvP session.
 *
 * Uses Web Share API when available (native iOS/Android share sheet → Threads,
 * IG, Line, etc.) and falls back to clipboard + toast on desktop.
 *
 * The generated link embeds `?exam=<id>&subject=<tag>&from=share` so that when
 * a friend taps it, App.jsx's deep-link handler drops them straight into that
 * exam — Practice will auto-select the shared subject via
 * `practice-default-subject:<exam>` written by the deep-link handler.
 *
 * GA4 events fired:
 *   - share (method, content_type, item_id: <exam>, subject)
 */
export default function ShareChallengeButton({
  exam,
  subject = null,        // subject_tag to pre-select for the receiver
  examName = '國考',
  subjectName = null,    // human-readable subject label for the message body
  correct = 0,
  total = 0,
  mode = 'practice',     // 'practice' | 'mock' | 'pvp'
  className = '',
}) {
  const [toast, setToast] = useState('')
  const pct = total > 0 ? Math.round((correct / total) * 100) : 0

  const buildUrl = () => {
    const origin = (typeof window !== 'undefined' && window.location?.origin) || 'https://examking.tw'
    const qs = new URLSearchParams()
    if (subject) qs.set('subject', subject)
    qs.set('from', 'share')
    // Use canonical exam-landing path /{examId}/ instead of /?exam=X to keep
    // Google index + GA4 page_view consistent with sitemap entries.
    const path = exam ? `/${exam}/` : '/'
    return `${origin}${path}?${qs.toString()}`
  }

  const buildMessage = (url) => {
    const label = subjectName || examName
    const base = mode === 'pvp'
      ? `我剛在國考知識王對戰贏了，${label} 正確率 ${pct}%！來挑戰我 →`
      : mode === 'mock'
      ? `我剛在國考知識王完成 ${examName} 模擬考，${total} 題答對 ${correct}（${pct}%）！你敢挑戰嗎 →`
      : `我剛在國考知識王練了 ${total} 題 ${label}，正確率 ${pct}%！來挑戰看看 →`
    return `${base} ${url}`
  }

  const fireGA = (method) => {
    if (typeof window === 'undefined' || typeof window.gtag !== 'function') return
    try {
      window.gtag('event', 'share', {
        method,
        content_type: 'challenge_link',
        item_id: exam || 'unknown',
        subject: subject || null,
        mode,
      })
    } catch {}
  }

  const onClick = async () => {
    const url = buildUrl()
    const text = buildMessage(url)

    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ title: '國考知識王 挑戰連結', text, url })
        fireGA('web_share_api')
        return
      } catch (e) {
        // User cancelled — don't fall through to clipboard
        if (e?.name === 'AbortError') return
      }
    }

    // Clipboard fallback
    try {
      await navigator.clipboard.writeText(text)
      fireGA('clipboard')
      setToast('已複製挑戰連結！貼到 Threads、IG 或 Line 分享吧')
      setTimeout(() => setToast(''), 2800)
    } catch {
      fireGA('clipboard_failed')
      setToast('無法複製，請手動選取')
      setTimeout(() => setToast(''), 2800)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        className={`flex items-center justify-center gap-2 bg-gradient-to-r from-pink-500 to-rose-500 text-white font-bold px-6 py-3 rounded-2xl active:scale-95 transition-transform shadow-lg ${className}`}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="18" cy="5" r="3"/>
          <circle cx="6"  cy="12" r="3"/>
          <circle cx="18" cy="19" r="3"/>
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
        </svg>
        分享挑戰
      </button>
      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-black/80 text-white text-sm px-4 py-2 rounded-full shadow-lg z-50 pointer-events-none">
          {toast}
        </div>
      )}
    </>
  )
}
