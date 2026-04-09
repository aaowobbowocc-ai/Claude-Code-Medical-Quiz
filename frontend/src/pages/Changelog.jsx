import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import Footer from '../components/Footer'

const TAG_STYLE = {
  reply:   { label: '回覆', bg: 'bg-purple-50', text: 'text-purple-600', border: 'border-purple-200' },
  feature: { label: '新功能', bg: 'bg-emerald-50', text: 'text-emerald-600', border: 'border-emerald-200' },
  fix:     { label: '修正', bg: 'bg-red-50', text: 'text-red-600', border: 'border-red-200' },
  improve: { label: '改善', bg: 'bg-blue-50', text: 'text-blue-600', border: 'border-blue-200' },
  notice:  { label: '公告', bg: 'bg-amber-50', text: 'text-amber-600', border: 'border-amber-200' },
}

function TagBadge({ tag }) {
  const s = TAG_STYLE[tag] || TAG_STYLE.notice
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold border ${s.bg} ${s.text} ${s.border}`}>
      {s.label}
    </span>
  )
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric' })
}

export default function Changelog() {
  const navigate = useNavigate()
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/changelog.json')
      .then(r => r.json())
      .then(data => { setEntries(data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      {/* Header */}
      <div className="grad-header px-5 pt-14 pb-6">
        <button onClick={() => navigate(-1)}
                className="absolute top-4 left-3 text-white/70 text-sm flex items-center gap-1 active:scale-95">
          ← 返回
        </button>
        <h1 className="text-white font-bold text-2xl text-center">📢 更新公告</h1>
        <p className="text-white/50 text-sm text-center mt-1">回饋回覆 · 功能更新</p>
      </div>

      {/* Content */}
      <div className="flex-1 px-4 py-5">
        {loading ? (
          <div className="text-center text-gray-400 py-12">
            <div className="flex gap-1.5 justify-center py-2">
              {[0,1,2].map(i => (
                <span key={i} className="w-2 h-2 rounded-full bg-gray-300 animate-bounce"
                      style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </div>
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center text-gray-400 py-12">
            <p className="text-4xl mb-3">📭</p>
            <p className="text-sm">尚無更新紀錄</p>
          </div>
        ) : (
          <div className="space-y-4">
            {entries.map((entry, idx) => (
              <div key={idx} className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
                <div className="flex items-center gap-2 mb-2">
                  <TagBadge tag={entry.tag} />
                  <span className="text-xs text-gray-400">{formatDate(entry.date)}</span>
                </div>
                <h3 className="font-bold text-sm text-medical-dark mb-2">{entry.title}</h3>

                {/* User feedback quote */}
                {entry.feedback && (
                  <div className="bg-gray-50 rounded-xl px-3 py-2.5 mb-3 border-l-3 border-purple-300">
                    <p className="text-xs text-gray-400 mb-1">💬 使用者回饋</p>
                    <p className="text-sm text-gray-600 leading-relaxed">{entry.feedback}</p>
                  </div>
                )}

                {/* Response / items */}
                <ul className="space-y-1.5">
                  {entry.items.map((item, i) => (
                    <li key={i} className="text-sm text-gray-600 leading-relaxed flex gap-2">
                      <span className={`shrink-0 mt-0.5 ${entry.tag === 'reply' ? 'text-purple-400' : 'text-gray-300'}`}>
                        {entry.tag === 'reply' ? '→' : '•'}
                      </span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        <p className="text-center text-xs text-gray-300 mt-6 mb-2">
          你的回饋我都有看到！歡迎透過「意見回饋」告訴我 💌
        </p>
      </div>

      <Footer />
    </div>
  )
}
