import { useState, useEffect, useCallback } from 'react'
import { usePlayerStore } from '../store/gameStore'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

function getUserId() {
  let id = localStorage.getItem('comment-uid')
  if (!id) {
    id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    localStorage.setItem('comment-uid', id)
  }
  return id
}

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

export default function CommentSection({ targetId }) {
  const [comments, setComments] = useState([])
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [posting, setPosting] = useState(false)
  const [likedIds, setLikedIds] = useState(() => {
    try { return JSON.parse(localStorage.getItem('comment-likes') || '[]') } catch { return [] }
  })
  const [reportedIds, setReportedIds] = useState(() => {
    try { return JSON.parse(localStorage.getItem('comment-reports') || '[]') } catch { return [] }
  })
  const [showAll, setShowAll] = useState(false)

  const name = usePlayerStore(s => s.name) || '匿名'
  const avatar = usePlayerStore(s => s.avatar) || '👤'
  const userId = getUserId()

  const fetchComments = useCallback(() => {
    if (!targetId) return
    fetch(`${BACKEND}/comments?target=${encodeURIComponent(targetId)}`)
      .then(r => r.json())
      .then(data => { setComments(data.comments || []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [targetId])

  useEffect(() => { fetchComments() }, [fetchComments])

  const handlePost = async () => {
    if (!text.trim() || posting) return
    setPosting(true)
    try {
      const res = await fetch(`${BACKEND}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: targetId, name, avatar, text: text.trim(), userId }),
      })
      const data = await res.json()
      if (data.ok) {
        setComments(prev => [...prev, data.comment])
        setText('')
      }
    } catch {}
    setPosting(false)
  }

  const handleLike = async (commentId) => {
    try {
      const res = await fetch(`${BACKEND}/comments/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: targetId, commentId, userId }),
      })
      const data = await res.json()
      if (data.ok) {
        setComments(prev => prev.map(c => c.id === commentId ? { ...c, likes: data.likes } : c))
        const newLiked = data.liked ? [...likedIds, commentId] : likedIds.filter(id => id !== commentId)
        setLikedIds(newLiked)
        localStorage.setItem('comment-likes', JSON.stringify(newLiked))
      }
    } catch {}
  }

  const handleReport = async (commentId) => {
    if (reportedIds.includes(commentId)) return
    if (!confirm('確定要檢舉此留言嗎？')) return
    try {
      await fetch(`${BACKEND}/comments/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: targetId, commentId, userId }),
      })
      const newReported = [...reportedIds, commentId]
      setReportedIds(newReported)
      localStorage.setItem('comment-reports', JSON.stringify(newReported))
    } catch {}
  }

  // Already sorted by likes from backend, just limit display
  const displayComments = showAll ? comments : comments.slice(0, 5)

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm font-bold text-gray-700">💬 留言討論</span>
        <span className="text-xs text-gray-400">{comments.length} 則</span>
      </div>

      {loading ? (
        <div className="text-center text-gray-300 text-xs py-4">載入中...</div>
      ) : (
        <>
          {comments.length > 5 && !showAll && (
            <button onClick={() => setShowAll(true)}
              className="w-full text-center text-xs text-medical-blue py-2 mb-2 active:scale-95">
              查看更早的 {comments.length - 5} 則留言
            </button>
          )}

          <div className="space-y-2.5">
            {displayComments.map(c => (
              <div key={c.id} className="bg-gray-50 rounded-xl px-3 py-2.5">
                {c.deleted ? (
                  <p className="text-xs text-gray-400 italic py-1">此留言已被刪除</p>
                ) : (
                  <>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-base">{c.avatar}</span>
                      <span className="text-xs font-bold text-gray-700">{c.name}</span>
                      <span className="text-xs text-gray-300 ml-auto">{timeAgo(c.createdAt)}</span>
                    </div>
                    <p className="text-sm text-gray-600 leading-relaxed mb-1.5">{c.text}</p>
                    <div className="flex items-center gap-3">
                      <button onClick={() => handleLike(c.id)}
                        className={`flex items-center gap-1 text-xs active:scale-95 transition-transform ${likedIds.includes(c.id) ? 'text-red-500' : 'text-gray-400'}`}>
                        {likedIds.includes(c.id) ? '❤️' : '🤍'} {c.likes > 0 ? c.likes : ''}
                      </button>
                      {!reportedIds.includes(c.id) ? (
                        <button onClick={() => handleReport(c.id)}
                          className="text-xs text-gray-300 active:scale-95 transition-transform">
                          🚩
                        </button>
                      ) : (
                        <span className="text-xs text-gray-300">已檢舉</span>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>

          {comments.length === 0 && (
            <div className="text-center text-gray-300 text-xs py-4">還沒有留言，來當第一個吧！</div>
          )}
        </>
      )}

      {/* Input */}
      <div className="flex gap-2 mt-3">
        <input
          type="text"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handlePost()}
          placeholder="分享你的心得..."
          maxLength={500}
          className="flex-1 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-medical-blue transition-colors"
        />
        <button onClick={handlePost} disabled={!text.trim() || posting}
          className="px-4 py-2.5 rounded-xl text-sm font-bold text-white grad-cta active:scale-95 disabled:opacity-40 transition-all shrink-0">
          送出
        </button>
      </div>
    </div>
  )
}
