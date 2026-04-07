import React, { useState } from 'react'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

/* Render markdown-lite text with bold, bullets */
function renderText(text) {
  if (!text) return null
  return text.split('\n').map((line, i) => {
    if (!line.trim()) return <div key={i} className="h-2" />

    const parts = line.split(/(\*\*[^*]+\*\*)/)
    const rendered = parts.map((p, j) =>
      p.startsWith('**') && p.endsWith('**')
        ? <strong key={j} className="font-bold text-medical-dark">{p.slice(2, -2)}</strong>
        : p
    )

    const isBullet = line.trimStart().startsWith('（') || line.trimStart().startsWith('•') || line.trimStart().startsWith('-')

    return (
      <p key={i} className={`leading-relaxed ${isBullet ? 'pl-2' : ''}`}>
        {rendered}
      </p>
    )
  })
}

/* Explain panel — shown below a question after reveal */
export function ExplainPanel({ text, loading, onRequest, requested, answer, options, limitHit, notEnoughCoins, remaining, explanation, cost = 200, questionId, questionText, rocYear, session, number, disputed }) {
  const [showAI, setShowAI] = useState(false)
  const [reportSent, setReportSent] = useState(false)
  const [showReportForm, setShowReportForm] = useState(false)
  const [reportText, setReportText] = useState('')
  const [reportSending, setReportSending] = useState(false)

  const hasExplanation = !!explanation

  return (
    <div className="flex flex-col gap-2">
      {/* 參考答案 */}
      {answer && options && (
        <div className="bg-white rounded-2xl border-2 border-medical-teal px-4 py-3">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-xs font-semibold text-medical-teal tracking-wide">📋 參考答案</p>
            <button
              onClick={() => {
                if (reportSent) return
                setShowReportForm(v => !v)
              }}
              disabled={reportSent}
              className={`text-xs px-2 py-0.5 rounded-lg transition-colors ${
                reportSent
                  ? 'bg-gray-100 text-gray-400'
                  : 'bg-red-50 text-red-500 active:bg-red-100'
              }`}
            >
              {reportSent ? '✓ 已回報' : '⚠️ 回報錯誤'}
            </button>
          </div>
          <div className="flex items-start gap-2.5">
            <span className="font-bold text-medical-teal text-base shrink-0 w-5">{answer}</span>
            <span className="text-sm text-gray-700 leading-snug">{options[answer]}</span>
          </div>
          {disputed && (
            <div className="mt-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              <p className="text-xs font-semibold text-amber-700">⚠️ 爭議題</p>
              <p className="text-xs text-amber-600 mt-0.5">{disputed}</p>
            </div>
          )}
          {showReportForm && !reportSent && (
            <div className="mt-3 pt-3 border-t border-gray-100">
              <textarea
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-xs resize-none outline-none focus:border-red-300 transition-colors"
                rows={2}
                placeholder="請描述問題（例：答案有誤、選項缺漏、題目不完整...）"
                value={reportText}
                onChange={e => setReportText(e.target.value)}
                maxLength={500}
              />
              <div className="flex justify-end gap-2 mt-2">
                <button
                  onClick={() => { setShowReportForm(false); setReportText('') }}
                  className="text-xs px-3 py-1.5 rounded-lg bg-gray-100 text-gray-500 active:bg-gray-200"
                >取消</button>
                <button
                  onClick={async () => {
                    setReportSending(true)
                    try {
                      await fetch(`${BACKEND}/report`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          questionId: questionId || '未知',
                          questionText: questionText || '',
                          rocYear: rocYear || '',
                          session: session || '',
                          number: number || '',
                          message: reportText.trim(),
                        }),
                      })
                      setReportSent(true)
                      setShowReportForm(false)
                    } catch {}
                    setReportSending(false)
                  }}
                  disabled={reportSending}
                  className="text-xs px-3 py-1.5 rounded-lg bg-red-500 text-white font-medium active:bg-red-600 disabled:opacity-50"
                >{reportSending ? '送出中...' : '送出回報'}</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 預存解答 */}
      {hasExplanation && (
        <div className="bg-gradient-to-br from-emerald-50 to-teal-50 rounded-2xl p-4 border border-emerald-100">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg">📝</span>
            <span className="font-bold text-emerald-700 text-sm">參考解答</span>
            <span className="text-xs text-gray-400 ml-0.5">僅供參考</span>
          </div>
          <div className="text-sm text-gray-700 flex flex-col gap-1">
            {renderText(explanation)}
          </div>
        </div>
      )}

      {/* AI 解說按鈕（可選） */}
      {!showAI && !requested && (
        <button
          onClick={() => {
            if (hasExplanation) {
              setShowAI(true)
            } else {
              onRequest()
            }
          }}
          disabled={!hasExplanation && remaining === 0}
          className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border-2 border-dashed text-sm font-medium transition-transform
            ${remaining === 0 && !hasExplanation
              ? 'border-gray-200 text-gray-400 bg-gray-50 cursor-not-allowed'
              : 'border-medical-blue text-medical-blue bg-blue-50 active:scale-95'}`}
        >
          <span className="text-base">🤖</span>
          {hasExplanation ? 'AI 進階解說' : 'AI 解說這題'}
          <span className="text-xs opacity-60 ml-1">🪙 {cost}</span>
        </button>
      )}

      {/* AI 解說面板（展開後） */}
      {(showAI || requested) && (
        <>
          {!requested ? (
            <button
              onClick={onRequest}
              disabled={remaining === 0}
              className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border-2 border-dashed text-sm font-medium transition-transform
                ${remaining === 0
                  ? 'border-gray-200 text-gray-400 bg-gray-50 cursor-not-allowed'
                  : 'border-medical-blue text-medical-blue bg-blue-50 active:scale-95'}`}
            >
              <span className="text-base">🤖</span>
              {remaining === 0 ? '今日 AI 額度已用完' : 'AI 解說這題'}
              {remaining > 0 && <span className="text-xs opacity-60 ml-1">🪙 {cost}</span>}
            </button>
          ) : notEnoughCoins ? (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-center">
              <p className="text-2xl mb-2">🪙</p>
              <p className="text-sm font-semibold text-amber-700">金幣不足</p>
              <p className="text-xs text-amber-500 mt-1">AI 解說需要 {cost} 金幣，多練習賺取金幣吧！</p>
            </div>
          ) : limitHit ? (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-center">
              <p className="text-2xl mb-2">😴</p>
              <p className="text-sm font-semibold text-amber-700">今日解說已達上限</p>
              <p className="text-xs text-amber-500 mt-1">個人每天 10 次，明天 00:00 重置</p>
            </div>
          ) : (
            <div className="bg-gradient-to-br from-blue-50 to-teal-50 rounded-2xl p-4 border border-blue-100">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-lg">🤖</span>
                <span className="font-bold text-medical-blue text-sm">AI 解說</span>
                <span className="text-xs text-gray-400 ml-0.5">僅供參考</span>
                {loading && (
                  <span className="flex gap-1 ml-1">
                    {[0,1,2].map(i => (
                      <span key={i} className="w-1.5 h-1.5 rounded-full bg-medical-blue animate-bounce"
                            style={{ animationDelay: `${i * 0.12}s` }} />
                    ))}
                  </span>
                )}
              </div>
              <div className="text-sm text-gray-700 flex flex-col gap-1">
                {renderText(text)}
                {loading && !text && (
                  <div className="h-4 w-3/4 bg-blue-100 rounded animate-pulse" />
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* Review panel — shown on results screen */
export function ReviewPanel({ text, loading, onRequest, requested }) {
  if (!requested) {
    return (
      <button
        onClick={onRequest}
        className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl font-bold text-base active:scale-95 transition-transform"
        style={{ background: 'linear-gradient(135deg, #1A6B9A22, #0D948822)', border: '2px dashed #1A6B9A' }}
      >
        <span className="text-xl">🤖</span>
        <span className="text-medical-blue">AI 個人化檢討報告</span>
      </button>
    )
  }

  return (
    <div className="bg-white rounded-2xl border border-blue-100 shadow-sm overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-2 border-b border-blue-50"
           style={{ background: 'linear-gradient(135deg, #EFF6FF, #F0FDFA)' }}>
        <span className="text-xl">🤖</span>
        <span className="font-bold text-medical-blue">AI 檢討報告</span>
        <span className="text-xs text-gray-400 ml-1">Gemini Flash</span>
        {loading && (
          <span className="flex gap-1 ml-auto">
            {[0,1,2].map(i => (
              <span key={i} className="w-1.5 h-1.5 rounded-full bg-medical-blue animate-bounce"
                    style={{ animationDelay: `${i * 0.12}s` }} />
            ))}
          </span>
        )}
      </div>
      <div className="px-4 py-4 text-sm text-gray-700 flex flex-col gap-1.5">
        {text ? renderText(text) : (
          <div className="flex flex-col gap-2">
            {[80, 60, 75, 50].map((w, i) => (
              <div key={i} className="h-4 rounded animate-pulse bg-gray-100" style={{ width: `${w}%` }} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
