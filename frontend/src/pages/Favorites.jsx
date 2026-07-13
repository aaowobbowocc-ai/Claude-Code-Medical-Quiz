import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useBookmarks } from '../hooks/useBookmarks'
import { useExplain } from '../hooks/useAI'
import { ExplainPanel } from '../components/AIPanel'
import { getSubjectColor } from '../utils/subjectColors'
import { formatYearSession } from '../utils/sessionLabel'
import { usePlayerStore } from '../store/gameStore'
import QuestionImages from '../components/QuestionImages'
import HazardVideo from '../components/HazardVideo'
import CommentSection from '../components/CommentSection'

function FavCard({ q, index, onRemove }) {
  const [open, setOpen] = useState(false)
  const [explainReq, setExplainReq] = useState(false)
  const [copied, setCopied] = useState(false)
  const { text: explainText, loading: explainLoading, limitHit, notEnoughCoins, error: explainError, explain, remaining, cost: explainCost, meta: explainMeta, vote: explainVote } = useExplain()

  const tagName = q.subject_name || q.subject || '未分類'
  const tagColor = getSubjectColor(tagName)

  // 複製題目（回饋 胖呆）— 題幹 + 四選項 + 答案
  const copyQuestion = () => {
    const opts = Object.entries(q.options || {}).map(([k, v]) => `(${k}) ${v}`).join('\n')
    const text = `${q.question}\n${opts}${q.answer ? `\n答案：${q.answer}` : ''}`
    try {
      navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select()
      try { document.execCommand('copy') } catch {}; document.body.removeChild(ta)
    }
    setCopied(true); setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <span className="text-xs font-semibold text-white px-2 py-0.5 rounded-full" style={{ background: tagColor }}>
          {tagName}
        </span>
        <span className="text-xs text-gray-400">{formatYearSession(q)}</span>
        <span className="text-xs font-mono font-semibold text-gray-500 bg-gray-100 px-2 py-0.5 rounded-lg">#{q.number}</span>
        <span className="flex-1" />
        <button onClick={copyQuestion} className="text-xs mr-1 active:scale-90 transition-transform" title="複製題目">
          {copied ? '✓' : '📋'}
        </button>
        <button onClick={() => onRemove(q)} className="text-sm active:scale-90 transition-transform" title="取消收藏">⭐</button>
        <button onClick={() => setOpen(o => !o)} className="text-xs text-gray-400 flex items-center gap-0.5">
          {open ? '收起' : '展開'}
          <span className={`transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
        </button>
      </div>

      <div className="px-4 pb-3">
        {q.case_context && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-2">
            <span className="text-[10px] font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full mb-1.5 inline-block">案例</span>
            <p className="text-sm text-gray-700 leading-relaxed">{q.case_context}</p>
          </div>
        )}
        <p className="text-sm text-gray-800 leading-relaxed">{q.question}</p>
        <QuestionImages images={q.images} imageUrl={q.image_url} incomplete={q.incomplete} />
        <HazardVideo src={q.video_url} sourceUrl={q.source_url} />
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
              error={explainError}
              remaining={remaining}
              cost={explainCost}
              requested={explainReq}
              onRequest={() => { setExplainReq(true); explain(q) }}
              answer={q.answer}
              options={q.options}
              explanation={q.explanation}
              questionId={q.id}
              examId={q.examId || usePlayerStore.getState().exam}
              questionText={q.question}
              rocYear={q.roc_year}
              session={q.session}
              number={q.number}
              disputed={q.disputed_note || q.disputed}
              visionUncertain={q.vision_uncertain}
              subjectTags={q.subject_tags}
              meta={explainMeta}
              onVote={explainVote}
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
  const [groupBySubj, setGroupBySubj] = useState(false)   // 收藏依科目分組（回饋 胖呆）
  const [practiceCount, setPracticeCount] = useState(0)   // 練習題數，0=全部（回饋 胖呆）

  const questions = getFolderQuestions(activeTab)

  // 練習此收藏夾（回饋 楊迪欣：現在點開就看到答案，想能作答）— 對齊自主練習計費
  const startFolderPractice = () => {
    let qs = questions.filter(q => q.options && Object.keys(q.options).length >= 2 && q.answer)
    if (practiceCount > 0) qs = qs.slice(0, practiceCount)
    if (!qs.length) return
    const FEE_PER_Q = 4
    const fee = qs.length * FEE_PER_Q
    const { spendCoins, coins } = usePlayerStore.getState()
    if (!spendCoins(fee)) {
      if (confirm(`金幣不足！練習此收藏夾需要 ${fee} 金幣（${qs.length} 題 × ${FEE_PER_Q}，全對可全額賺回），目前只有 ${coins} 金幣\n\n要去賺金幣嗎？`)) navigate('/?reward=1')
      return
    }
    navigate('/practice', { state: { presetPractice: qs, presetLabel: `收藏「${activeTab}」練習` } })
  }

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
            {questions.length > 10 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs text-gray-400 mr-0.5">題數</span>
                {[10, 30, 50, 100].filter(n => n < questions.length).map(n => (
                  <button key={n} onClick={() => setPracticeCount(n)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-bold border active:scale-95 ${practiceCount === n ? 'bg-medical-blue text-white border-medical-blue' : 'bg-white text-gray-600 border-gray-200'}`}>
                    {n}
                  </button>
                ))}
                <button onClick={() => setPracticeCount(0)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-bold border active:scale-95 ${practiceCount === 0 ? 'bg-medical-blue text-white border-medical-blue' : 'bg-white text-gray-600 border-gray-200'}`}>
                  全部 ({questions.length})
                </button>
              </div>
            )}
            {(() => {
              const n = practiceCount > 0 ? Math.min(practiceCount, questions.length) : questions.length
              return (
                <button onClick={startFolderPractice}
                  className="w-full py-3 rounded-2xl font-bold text-white text-sm shadow active:scale-95"
                  style={{ background: 'linear-gradient(135deg,#3b82f6,#2563eb)' }}>
                  ✍️ 練習此收藏夾（{n} 題 · 扣 {n * 4} 🪙）
                </button>
              )
            })()}
            <div className="flex justify-between items-center">
              <button onClick={() => setGroupBySubj(v => !v)}
                className={`text-xs font-bold px-3 py-1.5 rounded-xl border active:scale-95 transition-all ${groupBySubj ? 'bg-teal-500 text-white border-teal-500' : 'bg-white text-teal-600 border-teal-200'}`}>
                {groupBySubj ? '✓ 分科目' : '📁 分科目'}
              </button>
              <button onClick={() => { if (confirm(`確定清空「${activeTab}」的所有題目？`)) clearFolder(activeTab) }}
                className="text-xs text-red-400 active:scale-95">清空此收藏夾</button>
            </div>
            {!groupBySubj && questions.map((q, i) => (
              <FavCard key={q.id || i} q={q} index={i} onRemove={removeBookmark} />
            ))}
            {groupBySubj && (() => {
              const groups = {}
              questions.forEach(q => {
                const k = q.subject_name || q.subject || '未分類'
                ;(groups[k] = groups[k] || []).push(q)
              })
              const ordered = Object.entries(groups).sort((a, b) => b[1].length - a[1].length)
              return ordered.map(([name, qs]) => (
                <div key={name} className="flex flex-col gap-3">
                  <div className="flex items-center gap-2 mt-1 px-1">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: getSubjectColor(name) }} />
                    <span className="font-bold text-gray-700 text-sm">{name}</span>
                    <span className="text-gray-400 text-xs">{qs.length} 題</span>
                  </div>
                  {qs.map((q, i) => (
                    <FavCard key={q.id || i} q={q} index={i} onRemove={removeBookmark} />
                  ))}
                </div>
              ))
            })()}
          </>
        )}
      </div>
    </div>
  )
}
