import { useState, useEffect, useRef } from 'react'
import { usePlayerStore } from '../store/gameStore'

const TOUR_SEEN_KEY = 'welcome-tour-seen-v1'

// Interactive dark-mode toggle — flips the actual app dark mode while in the tour
function DarkModeToggle() {
  const darkMode = usePlayerStore(s => s.darkMode)
  const toggleDarkMode = usePlayerStore(s => s.toggleDarkMode)
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="text-5xl">{darkMode ? '🌙' : '☀️'}</div>
      <button onClick={toggleDarkMode}
        className={`relative w-20 h-10 rounded-full transition-colors active:scale-95 ${darkMode ? 'bg-slate-700' : 'bg-amber-300'}`}>
        <div className={`absolute top-1 w-8 h-8 bg-white rounded-full shadow-md transition-all ${darkMode ? 'right-1' : 'left-1'} flex items-center justify-center`}>
          <span className="text-base">{darkMode ? '🌙' : '☀️'}</span>
        </div>
      </button>
      <p className="text-xs text-medical-blue font-bold">點一下切換看看</p>
    </div>
  )
}

// Small caption color, much brighter in dark mode for readability
const caption = (dark) => dark ? 'text-white/85' : 'text-gray-500'
const accent = (dark) => dark ? 'text-sky-300' : 'text-medical-blue'

const SLIDES = [
  {
    icon: '🌙',
    title: '深色模式',
    desc: '夜間長時間刷題不傷眼',
    detail: '網站「最下方頁尾」也有深色模式切換。設定會記住，下次造訪自動套用。深夜讀書或床上滑題目時開啟，眼睛比較舒服。',
    illust: () => <DarkModeToggle />,
  },
  {
    icon: '🎯',
    title: '自主練習',
    desc: '依考試科目隨機出題，每題都附 AI 詳解',
    detail: '挑你想練的科目，系統隨機抽題。答錯立刻看 AI 解析，不確定的概念當下就釐清。練習越多、出題越準。',
    illust: (dark) => (
      <div className="flex flex-col items-center gap-2">
        <div className="text-6xl">📝</div>
        <div className={`rounded-xl px-3 py-2 text-xs font-bold border ${dark ? 'bg-sky-900/40 text-sky-200 border-sky-400/40' : 'bg-medical-light text-medical-blue border-medical-blue/30'}`}>
          下列何者最可能是…
        </div>
        <div className="grid grid-cols-2 gap-1 w-full max-w-[180px]">
          {['A', 'B', 'C', 'D'].map(o => (
            <div key={o} className={`text-xs px-2 py-1 rounded-lg border ${
              o === 'C'
                ? (dark ? 'bg-emerald-900/40 border-emerald-400/50 text-emerald-300 font-bold' : 'bg-emerald-50 border-emerald-300 text-emerald-700 font-bold')
                : (dark ? 'bg-white/5 border-white/15 text-gray-300' : 'bg-white border-gray-200 text-gray-500')
            }`}>
              {o}. 選項 {o}
            </div>
          ))}
        </div>
      </div>
    ),
  },
  {
    icon: '📊',
    title: '模擬考',
    desc: '歷屆原卷或隨機混合，限時模擬真實考場',
    detail: '可以選某年某次的整份原卷練習，或讓系統按比例隨機混合出 80 / 100 題。倒數計時、自動評分，結束後看每科正確率。',
    illust: (dark) => (
      <div className="flex flex-col items-center gap-2">
        <div className="text-6xl">📋</div>
        <div className="flex gap-2 text-xs">
          <span className={`px-2 py-1 rounded-lg font-bold ${dark ? 'bg-amber-900/40 text-amber-300' : 'bg-amber-100 text-amber-700'}`}>⏱ 120:00</span>
          <span className={`px-2 py-1 rounded-lg font-bold ${dark ? 'bg-sky-900/40 text-sky-300' : 'bg-medical-light text-medical-blue'}`}>第 1 / 80 題</span>
        </div>
      </div>
    ),
  },
  {
    icon: '⚔️',
    title: '即時對戰',
    desc: '邀朋友 PK 速度與正確率，或加入公開房間',
    detail: '建立私人房間給朋友 / 同學 PK，或加入公開房間隨機配對。即時計分、即時排行，比平常練習更刺激。',
    illust: (dark) => (
      <div className="flex flex-col items-center gap-2">
        <div className="flex items-center gap-3 text-4xl">
          <span>👨‍⚕️</span>
          <span className={`text-2xl font-bold ${accent(dark)}`}>VS</span>
          <span>👩‍⚕️</span>
        </div>
        <div className="flex gap-3 text-xs font-bold">
          <span className={dark ? 'text-emerald-300' : 'text-emerald-600'}>你 8/10 ✓</span>
          <span className={caption(dark)}>vs</span>
          <span className={dark ? 'text-rose-300' : 'text-rose-600'}>對手 5/10</span>
        </div>
      </div>
    ),
  },
  {
    icon: '⭐',
    title: '收藏 + 分享筆記',
    desc: '把難題加入收藏，也鼓勵大家分享讀書心得',
    detail: '看到難題或重點題就點星星收藏，分類成不同資料夾。每題都能寫筆記、看其他人寫的筆記。歡迎你也分享自己的記憶口訣、做題思路給其他考生，互相補強進步！',
    illust: (dark) => (
      <div className="flex flex-col items-center gap-2">
        <div className="text-6xl">📚</div>
        <div className="flex gap-1.5 flex-wrap justify-center text-xs">
          <span className={`px-2 py-1 rounded-lg border ${dark ? 'bg-amber-900/40 border-amber-400/40 text-amber-300' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>⭐ 已收藏</span>
          <span className={`px-2 py-1 rounded-lg border ${dark ? 'bg-sky-900/40 border-sky-400/40 text-sky-300' : 'bg-medical-light border-medical-blue/30 text-medical-blue'}`}>💬 12 則筆記</span>
        </div>
        <p className={`text-xs font-bold mt-1 ${accent(dark)}`}>分享你的讀書心得 ✨</p>
      </div>
    ),
  },
  {
    icon: '⚠️',
    title: '題目錯誤回報',
    desc: '看到答案錯、選項缺字，點 AI 解析旁的「⚠️ 回報錯誤」',
    detail: '考選部 PDF 抓回來解析難免有破口字、答案標記錯誤。發現問題時，題目展開 AI 解析後會看到「⚠️ 回報錯誤」按鈕，點下去寫一句說明送出。通常 1-2 天內處理修正並寫進更新公告。',
    illust: (dark) => (
      <div className="flex flex-col items-center gap-3">
        <div className="text-6xl">🔍</div>
        <button className={`text-xs px-2 py-0.5 rounded-lg pointer-events-none font-bold ${dark ? 'bg-red-900/40 text-red-300' : 'bg-red-50 text-red-500'}`}>
          ⚠️ 回報錯誤
        </button>
        <p className={`text-xs ${caption(dark)}`}>回報後 1-2 天內處理</p>
      </div>
    ),
  },
  {
    icon: '💌',
    title: '意見回饋',
    desc: '想要的功能、看到的小問題，都歡迎告訴我',
    detail: '網站最下方有「意見回饋」入口。希望加哪個考試、哪個功能不好用、UI 哪裡卡卡的——都可以提，會看每一則並排進開發清單。',
    illust: (dark) => (
      <div className="flex flex-col items-center gap-2">
        <div className="text-6xl">💬</div>
        <div className={`text-xs px-3 py-2 rounded-xl max-w-[220px] text-center border ${dark ? 'bg-sky-900/40 border-sky-400/40 text-sky-200' : 'bg-medical-light border-medical-blue/30 text-medical-blue'}`}>
          建議加入○○科考試 + 暗色模式預設…
        </div>
        <p className={`text-xs ${caption(dark)}`}>頁尾「💌 意見回饋」</p>
      </div>
    ),
  },
  {
    icon: '📱',
    title: '安裝到主畫面',
    desc: '加到桌面當 App 用，支援離線練習',
    detail: 'Android 用 Chrome、iOS 用 Safari，開分享選單選「加到主畫面」。安裝後桌面會出現國考知識王 icon，點開像 App 一樣快速開啟。',
    illust: (dark) => (
      <div className="flex flex-col items-center gap-2">
        <div className="grid grid-cols-3 gap-2">
          {['📅', null, '⏰', '📷', '🎵', '📧'].map((emo, i) => (
            <div key={i} className={`shadow rounded-xl w-12 h-12 flex items-center justify-center text-xl overflow-hidden ${
              emo === null
                ? `border-2 ${dark ? 'border-sky-400' : 'border-medical-blue'}`
                : (dark ? 'bg-white/10' : 'bg-white')
            }`}>
              {emo === null
                ? <img src="/icons/icon-192.png" alt="國考知識王" className="w-full h-full object-cover" />
                : emo}
            </div>
          ))}
        </div>
        <p className={`text-xs ${caption(dark)}`}>桌面 icon · 離線可用</p>
      </div>
    ),
  },
  {
    icon: '🎉',
    title: '準備好了！',
    desc: '隨時點首頁「🎬 看完整功能導覽」可以再看一次',
    detail: '所有題庫完全免費。如果覺得網站對你有幫助，歡迎到頁尾的「💛 贊助支持」小額贊助一杯咖啡，幫我分擔伺服器與 AI 解說 API 的費用。祝你高分上岸！',
    illust: (dark) => (
      <div className="flex flex-col items-center gap-3">
        <img src="/icons/icon-192.png" alt="國考知識王" className="w-20 h-20 rounded-2xl shadow-lg" />
        <div className={`text-sm font-bold ${accent(dark)}`}>國考知識王</div>
      </div>
    ),
  },
]

export default function WelcomeTour({ onClose }) {
  const [idx, setIdx] = useState(0)
  const startX = useRef(0)
  const darkMode = usePlayerStore(s => s.darkMode)
  const slide = SLIDES[idx]
  const isLast = idx === SLIDES.length - 1

  const finish = () => {
    try { localStorage.setItem(TOUR_SEEN_KEY, '1') } catch {}
    onClose && onClose()
  }

  const next = () => isLast ? finish() : setIdx(i => i + 1)
  const prev = () => idx > 0 && setIdx(i => i - 1)

  // Swipe support
  const handleStart = e => { startX.current = e.touches?.[0]?.clientX ?? e.clientX }
  const handleEnd = e => {
    const endX = e.changedTouches?.[0]?.clientX ?? e.clientX
    const dx = endX - startX.current
    if (dx < -60) next()
    else if (dx > 60) prev()
  }

  // ESC closes
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') finish(); else if (e.key === 'ArrowRight') next(); else if (e.key === 'ArrowLeft') prev() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [idx])

  const cardBg = darkMode ? 'bg-[#1f1f1f]' : 'bg-white'
  const headerGrad = darkMode ? 'from-[#0f1a2a] to-black' : 'from-medical-blue to-medical-dark'
  const illustBg = darkMode ? 'from-[#181818] to-[#1f1f1f]' : 'from-gray-50 to-white'
  const detailColor = darkMode ? 'text-white/85' : 'text-gray-500'
  const footerBg = darkMode ? 'bg-[#1f1f1f] border-white/15' : 'bg-white border-gray-100'
  const dotInactive = darkMode ? 'bg-white/30' : 'bg-gray-200'
  const prevText = darkMode ? 'text-gray-200 disabled:text-gray-500' : 'text-gray-500 disabled:text-gray-300'
  const nextText = darkMode ? 'text-sky-300' : 'text-medical-blue'

  return (
    <div className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-4"
         onClick={finish}>
      <div className={`w-full max-w-sm rounded-3xl shadow-2xl overflow-hidden max-h-[92vh] flex flex-col ${cardBg}`}
           onClick={e => e.stopPropagation()}
           onTouchStart={handleStart} onTouchEnd={handleEnd}
           onMouseDown={handleStart} onMouseUp={handleEnd}>
        {/* Header */}
        <div className={`bg-gradient-to-br ${headerGrad} px-5 pt-5 pb-4 text-white relative shrink-0`}>
          <button onClick={finish}
            className="absolute top-3 right-3 text-white/60 hover:text-white text-sm active:scale-90"
            aria-label="跳過">
            跳過 ✕
          </button>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-3xl">{slide.icon}</span>
            <h2 className="text-xl font-bold">{slide.title}</h2>
          </div>
          <p className="text-white/85 text-sm leading-snug">{slide.desc}</p>
        </div>

        {/* Illustration + detail */}
        <div className="flex-1 overflow-y-auto">
          <div className={`px-5 py-6 flex items-center justify-center min-h-[160px] bg-gradient-to-b ${illustBg}`}>
            {slide.illust(darkMode)}
          </div>
          {slide.detail && (
            <div className="px-5 pb-4">
              <p className={`text-sm leading-relaxed ${detailColor}`}>{slide.detail}</p>
            </div>
          )}
        </div>

        {/* Footer: dots + nav */}
        <div className={`flex items-center justify-between px-5 py-3 border-t shrink-0 ${footerBg}`}>
          <button onClick={prev} disabled={idx === 0}
            className={`text-sm active:scale-95 ${prevText}`}>
            ← 上一步
          </button>
          <div className="flex gap-1">
            {SLIDES.map((_, i) => (
              <span key={i}
                className={`w-1.5 h-1.5 rounded-full transition-colors ${i === idx ? (darkMode ? 'bg-sky-400' : 'bg-medical-blue') : dotInactive}`} />
            ))}
          </div>
          <button onClick={next}
            className={`text-sm font-bold active:scale-95 ${nextText}`}>
            {isLast ? '完成 🎉' : '下一步 →'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function shouldShowWelcomeTour() {
  try { return !localStorage.getItem(TOUR_SEEN_KEY) } catch { return false }
}

export function resetWelcomeTour() {
  try { localStorage.removeItem(TOUR_SEEN_KEY) } catch {}
}

