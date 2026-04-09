import React, { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useExplain } from '../hooks/useAI'
import { ExplainPanel } from '../components/AIPanel'
import SmartBanner from '../components/SmartBanner'
import { useBookmarks } from '../hooks/useBookmarks'
import { getSubjectColor } from '../utils/subjectColors'
import QuestionImages from '../components/QuestionImages'
import CommentSection from '../components/CommentSection'

/* ── Single question review card ───────────────────────────── */
function ReviewCard({ q, index, isBookmarked, onToggleBookmark }) {
  const [open, setOpen] = useState(!q.correct)  // auto-open wrong ones
  const [explainReq, setExplainReq] = useState(false)
  const { text: explainText, loading: explainLoading, limitHit, explain, remaining } = useExplain()

  const answerColor = '#10B981'   // green for correct
  const wrongColor  = '#EF4444'   // red for wrong

  return (
    <div className={`bg-white rounded-2xl shadow-sm border overflow-hidden
      ${q.correct ? 'border-green-100' : 'border-red-100'}`}>
      {/* Header */}
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <span className={`text-xs font-bold px-2 py-0.5 rounded-full text-white`}
              style={{ background: q.correct ? answerColor : wrongColor }}>
          {q.correct ? '✓ 答對' : '✗ 答錯'}
        </span>
        <span className="text-xs text-gray-400">第 {index + 1} 題</span>
        {q.subject_name && (
          <span className="text-xs font-semibold text-white px-1.5 py-0.5 rounded-full"
                style={{ background: getSubjectColor(q.subject_name) }}>
            {q.subject_name}
          </span>
        )}
        <span className="flex-1" />
        <button onClick={() => onToggleBookmark(q)}
                className="text-sm mr-1" title={isBookmarked ? '取消收藏' : '收藏錯題'}>
          {isBookmarked ? '⭐' : '☆'}
        </button>
        <button onClick={() => setOpen(o => !o)}
                className="text-xs text-gray-400 flex items-center gap-0.5">
          {open ? '收起' : '展開'}
          <span className={`transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
        </button>
      </div>

      {/* Question text */}
      <div className="px-4 pb-3">
        <p className="text-sm text-gray-800 leading-relaxed">{q.question}</p>
        <QuestionImages images={q.images} imageUrl={q.image_url} />
      </div>

      {/* Options + answer — collapsible */}
      {open && (
        <div className="px-4 pb-4 flex flex-col gap-1.5 border-t border-gray-50">
          {Object.entries(q.options).map(([letter, text]) => {
            const isCorrect  = q.answer === '送分' || (q.answer?.includes(',') ? q.answer.split(',').includes(letter) : q.answer === letter)
            const isMyWrong  = q.myAnswer === letter && !q.correct

            let bg = 'bg-gray-50'
            let textCls = 'text-gray-600'
            let border = 'border-transparent'
            if (isCorrect) { bg = 'bg-green-50'; textCls = 'text-green-800'; border = 'border-green-300' }
            if (isMyWrong) { bg = 'bg-red-50';   textCls = 'text-red-700';   border = 'border-red-300'   }

            return (
              <div key={letter}
                   className={`flex items-start gap-2.5 px-3 py-2.5 rounded-xl text-sm border ${bg} ${textCls} ${border}`}>
                <span className="font-bold shrink-0 w-4">{letter}</span>
                <span className="leading-snug flex-1">{text}</span>
                {isCorrect && <span className="ml-auto text-green-600 shrink-0">✓</span>}
                {isMyWrong && <span className="ml-auto text-red-500 shrink-0">✗</span>}
              </div>
            )
          })}

          {/* My answer summary */}
          {!q.correct && q.myAnswer && (
            <p className="text-xs text-gray-400 mt-1 px-1">
              你選了 <span className="font-semibold text-red-500">{q.myAnswer}</span>，
              正確答案是 <span className="font-semibold text-green-600">{q.answer === '送分' ? '一律給分' : q.answer?.replace(',', ' 或 ')}</span>
            </p>
          )}
          {!q.myAnswer && (
            <p className="text-xs text-gray-400 mt-1 px-1">未作答（時間到）</p>
          )}

          {/* AI Explain */}
          <div className="mt-2">
            <ExplainPanel
              text={explainText}
              loading={explainLoading}
              limitHit={limitHit}
              requested={explainReq}
              onRequest={() => { setExplainReq(true); explain({ question: q.question, options: q.options, answer: q.answer }) }}
              remaining={remaining}
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

/* ── Review page ─────────────────────────────────────────────── */
export default function Review() {
  const navigate = useNavigate()
  const { state } = useLocation()
  const [showAll, setShowAll] = useState(false)
  const { isBookmarked, toggle: toggleBookmark, bookmarks } = useBookmarks()
  const [showBookmarks, setShowBookmarks] = useState(false)

  if (!state?.questions && !showBookmarks) {
    if (bookmarks.length > 0) {
      // Allow viewing bookmarks directly
    } else {
      navigate('/')
      return null
    }
  }

  const questions = state?.questions || []
  const stage = state?.stage || '收藏題目'
  const wrong = questions.filter(q => !q.correct)
  const displayed = showBookmarks ? bookmarks : (showAll ? questions : wrong)

  return (
    <div className="flex flex-col min-h-dvh no-select bg-medical-ice">
      {/* Header */}
      <div className="sticky top-0 z-10 px-4 pt-12 pb-4 grad-header">
        <div className="flex items-center gap-3 mb-1">
          <button onClick={() => navigate(-1)} className="text-white/60 text-2xl leading-none">‹</button>
          <h1 className="text-white font-bold text-xl flex-1">錯題檢討</h1>
          <span className="text-white/50 text-sm">{stage}</span>
        </div>
        <div className="flex gap-2 mt-2">
          <div className="bg-white/10 rounded-xl px-3 py-1.5 text-center">
            <p className="text-white font-bold text-lg leading-none">{questions.filter(q => q.correct).length}</p>
            <p className="text-white/50 text-xs">答對</p>
          </div>
          <div className="bg-white/10 rounded-xl px-3 py-1.5 text-center">
            <p className="text-white font-bold text-lg leading-none">{wrong.length}</p>
            <p className="text-white/50 text-xs">答錯</p>
          </div>
          <div className="bg-white/10 rounded-xl px-3 py-1.5 text-center">
            <p className="text-white font-bold text-lg leading-none">{questions.length}</p>
            <p className="text-white/50 text-xs">總題</p>
          </div>
          {bookmarks.length > 0 && (
            <button
              onClick={() => setShowBookmarks(v => !v)}
              className="text-xs text-white/60 border border-white/20 px-3 py-1.5 rounded-xl">
              {showBookmarks ? '返回' : `⭐ ${bookmarks.length}`}
            </button>
          )}
          {!showBookmarks && questions.length > 0 && (
            <button
              onClick={() => setShowAll(v => !v)}
              className="ml-auto text-xs text-white/60 border border-white/20 px-3 py-1.5 rounded-xl">
              {showAll ? '只看錯題' : '看全部'}
            </button>
          )}
        </div>
        <p className="text-white/35 text-xs mt-2">每道 AI 解說使用共用的每日配額（100次/天）</p>
      </div>

      {/* Question list */}
      <div className="flex-1 px-4 py-4 flex flex-col gap-3">
        {displayed.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <span className="text-5xl">🎉</span>
            <p className="text-gray-400 text-sm font-medium">全部答對！太厲害了！</p>
          </div>
        )}
        {displayed.map((q, i) => (
          <ReviewCard key={q.id || i} q={q}
            index={showBookmarks ? i : questions.indexOf(q)}
            isBookmarked={isBookmarked(q)}
            onToggleBookmark={toggleBookmark} />
        ))}

        {/* 底部廣告 / 贊助橫幅 */}
        <SmartBanner />
      </div>
    </div>
  )
}
