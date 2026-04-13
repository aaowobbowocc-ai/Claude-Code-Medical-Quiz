import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/gameStore'

export default function SupportBar({ setSheet }) {
  const navigate = useNavigate()
  const darkMode = usePlayerStore(s => s.darkMode)
  const toggleDarkMode = usePlayerStore(s => s.toggleDarkMode)

  return (
    <div className="flex items-center justify-center gap-2 mt-3 pb-1 flex-wrap">
      <button onClick={() => navigate('/changelog')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-purple-500 bg-purple-50 border border-purple-200 active:scale-95 transition-transform shadow-sm font-medium">
        📢 更新公告
      </button>
      <button onClick={() => setSheet('contact')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-gray-400 bg-white border border-gray-100 active:scale-95 transition-transform shadow-sm">
        💌 意見回饋
      </button>
      <button onClick={() => setSheet('backup')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-emerald-600 bg-emerald-50 border border-emerald-200 active:scale-95 transition-transform shadow-sm font-medium">
        📦 備份資料
      </button>
      <button onClick={() => setSheet('donate')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-amber-500 bg-amber-50 border border-amber-200 active:scale-95 transition-transform shadow-sm font-medium">
        ☕ 贊助開發者
      </button>
      <button onClick={toggleDarkMode}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-gray-400 bg-white border border-gray-100 active:scale-95 transition-transform shadow-sm">
        {darkMode ? '☀️ 淺色' : '🌙 深色'}
      </button>
    </div>
  )
}
