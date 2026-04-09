import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useBookmarks } from '../hooks/useBookmarks'
import { useExplain } from '../hooks/useAI'
import { ExplainPanel } from '../components/AIPanel'
import { getSubjectColor } from '../utils/subjectColors'
import QuestionImages from '../components/QuestionImages'
import CommentSection from '../components/CommentSection'

function FavCard({ q, index, onRemove }) {
  const [open, setOpen] = useState(false)
  const [explainReq, setExplainReq] = useState(false)
  const { text: explainText, loading: explainLoading, limitHit, notEnoughCoins, explain, remaining, cost: explainCost } = useExplain()

  const tagName = q.subject_name || q.subject || '未分類'
  const tagColor = getSubjectColor(tagName)

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <span className="text-xs font-semibold text-white px-2 py-0.5 rounded-full" style={{ background: tagColor }}>
          {tagName}
        </span>
        <span className="text-xs text-gray-400">{q.roc_year}年{q.session}</span>
        <span className="text-xs font-mono font-semibold text-gray-500 bg-gray-100 px-2 py-0.5 rounded-lg">#{q.number}</span>
        <span className="flex-1" />
        <button onClick={() => onRemove(q)} className="text-sm active:scale-90 transition-transform" title="取消收藏">⭐</button>
        <button onClick={() => setOpen(o => !o)} className="text-xs text-gray-400 flex items-center gap-0.5">
          {open ? '收起' : '展開'}
          <span className={`transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
        </button>
      </div>

      <div className="px-4 pb-3">
        <p className="text-sm text-gray-800 leading-relaxed">{q.question}</p>
        <QuestionImages images={q.images} imageUrl={q.image_url} />
      </div>

      {open && (
        <div className="px-4 pb-4 flex flex-col gap-1.5 border-t border-gray-50">
          {Object.entries(q.options || {}).map(([letter, text]) => {
            const isAnswer = q.answer === '送分' || (q.answer?.includes(',') ? q.answer.split(',').includes(letter) : q.answer === letter)
            return (
              <div key={letter}
                className={`flex items-start gap-2.5 px-3 py-2.5 rounded-xl text-sm border ${isAnswer ? 'bg-green-50 text-green-800 border-green-300' : 'bg-gray-50 text-gray-600 border-transparent'}`}>
                <span className="font-bold shrink-0">{letter}.</span>
                <span className="flex-1">{text}</span>
                {isAnswer && <span className="shrink-0">✓</span>}
              </div>
            )
          })}

          <div className="mt-2">
            <ExplainPanel
              text={explainText}
              loading={explainLoading}
              limitHit={limitHit}
              notEnoughCoins={notEnoughCoins}
              remaining={remaining}
              cost={explainCost}
              requested={explainReq}
              onRequest={() => { setExplainReq(true); explain(q) }}
              answer={q.answer}
              options={q.options}
              explanation={q.explanation}
              questionId={q.id}
              questionText={q.question}
              rocYear={q.roc_year}
              session={q.session}
              number={q.number}
              disputed={q.disputed}
            />
            {q.id && <CommentSection targetId={`q_${q.id}`} />}
          </div>
        </div>
      )}
    </div>
  )
}

export default function Favorites() {
  const navigate = useNavigate()
  const { folders, getFolderQuestions, removeBookmark, renameFolder, clearFolder, MAX_PER_FOLDER } = useBookmarks()
  const [activeTab, setActiveTab] = useState(folders[0])
  const [editing, setEditing] = useState(null) // folder name being edited
  const [editValue, setEditValue] = useState('')

  const questions = getFolderQuestions(activeTab)

  const handleRename = () => {
    if (editValue.trim() && editValue.trim() !== editing) {
      renameFolder(editing, editValue.trim())
      if (activeTab === editing) setActiveTab(editValue.trim().slice(0, 10))
    }
    setEditing(null)
  }

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      <div className="sticky top-0 z-10 px-4 pt-12 pb-4 grad-header">
        <div className="flex items-center gap-3 mb-3">
          <button onClick={() => navigate(-1)} className="text-white/60 text-2xl leading-none">‹</button>
          <h1 className="text-white font-bold text-xl flex-1">⭐ 收藏題目</h1>
        </div>

        {/* Folder tabs */}
        <div className="flex gap-2">
          {folders.map(f => {
            const count = getFolderQuestions(f).length
            const isActive = activeTab === f
            return (
              <button key={f} onClick={() => setActiveTab(f)}
                onDoubleClick={() => { setEditing(f); setEditValue(f) }}
                className={`flex-1 py-2 rounded-xl text-sm font-bold transition-all active:scale-95 ${isActive ? 'bg-white text-medical-blue shadow' : 'bg-white/15 text-white/60'}`}>
                {f} ({count}/{MAX_PER_FOLDER})
              </button>
            )
          })}
        </div>
        <p className="text-white/30 text-xs mt-2">長按收藏夾名稱可重新命名</p>
      </div>

      {/* Rename dialog */}
      {editing && (
        <div className="px-4 py-3 bg-white border-b border-gray-100 flex gap-2 items-center">
          <input type="text" value={editValue} onChange={e => setEditValue(e.target.value)}
            maxLength={10} autoFocus
            className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-medical-blue" />
          <button onClick={handleRename}
            className="px-3 py-2 rounded-xl text-sm font-bold text-white bg-medical-blue active:scale-95">確認</button>
          <button onClick={() => setEditing(null)}
            className="px-3 py-2 rounded-xl text-sm font-bold text-gray-500 bg-gray-100 active:scale-95">取消</button>
        </div>
      )}

      <div className="flex-1 px-4 py-4 flex flex-col gap-3">
        {questions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <span className="text-5xl">📌</span>
            <p className="text-gray-400 text-sm">這個收藏夾還沒有題目</p>
            <p className="text-gray-300 text-xs">在題庫瀏覽或練習中按 ☆ 收藏</p>
          </div>
        ) : (
          <>
            <div className="flex justify-end">
              <button onClick={() => { if (confirm(`確定清空「${activeTab}」的所有題目？`)) clearFolder(activeTab) }}
                className="text-xs text-red-400 active:scale-95">清空此收藏夾</button>
            </div>
            {questions.map((q, i) => (
              <FavCard key={q.id || i} q={q} index={i} onRemove={removeBookmark} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}
