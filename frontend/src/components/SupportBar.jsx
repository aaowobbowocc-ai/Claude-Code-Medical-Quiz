import { usePlayerStore } from '../store/gameStore'

export default function SupportBar({ setSheet }) {
  const darkMode = usePlayerStore(s => s.darkMode)
  const toggleDarkMode = usePlayerStore(s => s.toggleDarkMode)

  return (
    <div className="flex items-center justify-center gap-2 mt-3 pb-1">
      <button onClick={toggleDarkMode}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-gray-400 bg-white border border-gray-100 active:scale-95 transition-transform shadow-sm">
        {darkMode ? '☀️ 淺色' : '🌙 深色'}
      </button>
      <button onClick={() => setSheet('donate')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-amber-500 bg-amber-50 border border-amber-200 active:scale-95 transition-transform shadow-sm font-medium">
        ☕ 贊助開發者
      </button>
      <button onClick={() => setSheet('contact')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-gray-400 bg-white border border-gray-100 active:scale-95 transition-transform shadow-sm">
        💌 意見回饋
      </button>
    </div>
  )
}
