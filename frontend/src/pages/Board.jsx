import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlayerStore } from '../store/gameStore'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '剛剛'
  if (mins < 60) return `${mins} 分鐘前`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} 小時前`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days} 天前`
  return new Date(dateStr).toLocaleDateString('zh-TW')
}

export default function Board() {
  const navigate = useNavigate()
  const { name, avatar, coins, spendCoins } = usePlayerStore()
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState('')
  const listRef = useRef(null)

  useEffect(() => {
    fetchMessages()
  }, [])

  async function fetchMessages() {
    setLoading(true)
    try {
      const r = await fetch(`${BACKEND}/board`)
      const data = await r.json()
      setMessages(data)
    } catch {
      setMessages([])
    }
    setLoading(false)
  }

  async function handlePost() {
    if (!text.trim()) return
    if (!name) { setError('請先設定名字（回主頁設定）'); return }

    setPosting(true)
    setError('')
    try {
      const r = await fetch(`${BACKEND}/board`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          avatar: avatar || '👨‍⚕️',
          message: text.trim(),
        }),
      })
      if (!r.ok) {
        const err = await r.json()
        setError(err.error || '發送失敗')
      } else {
        const newMsg = await r.json()
        setMessages(prev => [newMsg, ...prev])
        setText('')
        listRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
      }
    } catch {
      setError('網路錯誤，請稍後再試')
    }
    setPosting(false)
  }

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice no-select">
      {/* Header */}
      <div className="grad-header px-4 pt-12 pb-5">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/')} className="text-white/70 text-2xl active:scale-90">‹</button>
          <div className="flex-1">
            <h1 className="text-white font-bold text-xl">💬 留言板</h1>
            <p className="text-white/50 text-xs mt-0.5">和醫學生們交流備考心得</p>
          </div>
          <button onClick={fetchMessages} className="text-white/60 text-sm bg-white/10 px-3 py-1.5 rounded-xl active:scale-95">
            🔄 重新整理
          </button>
        </div>
      </div>

      {/* Message List */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {loading ? (
          <div className="text-center text-gray-400 py-12">
            <div className="flex gap-1.5 justify-center py-2">
              {[0,1,2].map(i => (
                <span key={i} className="w-2 h-2 rounded-full bg-gray-300 animate-bounce"
                      style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </div>
            <p className="text-sm mt-2">載入中...</p>
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center text-gray-400 py-12">
            <p className="text-4xl mb-3">💭</p>
            <p className="text-sm">還沒有留言</p>
            <p className="text-xs mt-1 text-gray-300">成為第一個留言的人吧！</p>
          </div>
        ) : (
          messages.map(msg => (
            <div key={msg.id} className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
              <div className="flex items-center gap-2.5 mb-2">
                <span className="text-2xl">{msg.avatar || '👨‍⚕️'}</span>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-sm text-medical-dark truncate">{msg.name}</p>
                  <p className="text-xs text-gray-400">{timeAgo(msg.created_at)}</p>
                </div>
              </div>
              <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-wrap break-words">{msg.message}</p>
            </div>
          ))
        )}

      </div>

      {/* Compose */}
      <div className="bg-white border-t border-gray-200 px-4 py-3 safe-bottom">
        {error && <p className="text-red-500 text-xs mb-2 text-center">{error}</p>}
        <div className="flex gap-2.5 items-end">
          <div className="flex-1">
            <textarea
              className="w-full border border-gray-200 rounded-2xl px-4 py-3 text-sm resize-none outline-none focus:border-medical-blue transition-colors"
              placeholder={name ? '分享你的備考心得...' : '請先回主頁設定名字'}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handlePost() } }}
              maxLength={500}
              rows={2}
              disabled={!name}
            />
            {text.length > 0 && (
              <p className="text-xs text-gray-300 text-right mt-0.5">{text.length}/500</p>
            )}
          </div>
          <button
            onClick={handlePost}
            disabled={posting || !text.trim() || !name}
            className="shrink-0 bg-medical-blue text-white font-bold text-sm px-5 py-3 rounded-2xl active:scale-95 transition-transform disabled:opacity-40"
          >
            {posting ? '...' : '發送'}
          </button>
        </div>
      </div>
    </div>
  )
}
