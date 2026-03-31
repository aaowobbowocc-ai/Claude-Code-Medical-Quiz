import React from 'react'

/* Render streamed markdown-lite text with bold, bullets */
function renderText(text) {
  if (!text) return null
  return text.split('\n').map((line, i) => {
    if (!line.trim()) return <div key={i} className="h-2" />

    // Bold headers: **text**
    const parts = line.split(/(\*\*[^*]+\*\*)/)
    const rendered = parts.map((p, j) =>
      p.startsWith('**') && p.endsWith('**')
        ? <strong key={j} className="font-bold text-medical-dark">{p.slice(2, -2)}</strong>
        : p
    )

    // Detect bullet-ish lines
    const isBullet = line.trimStart().startsWith('（') || line.trimStart().startsWith('•') || line.trimStart().startsWith('-')

    return (
      <p key={i} className={`leading-relaxed ${isBullet ? 'pl-2' : ''}`}>
        {rendered}
      </p>
    )
  })
}

/* Explain panel — shown below a question after reveal */
export function ExplainPanel({ text, loading, onRequest, requested, answer, options }) {
  if (!requested) {
    return (
      <button
        onClick={onRequest}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-dashed border-medical-blue text-medical-blue text-sm font-medium active:scale-95 transition-transform bg-blue-50"
      >
        <span className="text-lg">🤖</span>
        AI 解說這題
      </button>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {/* 參考答案 — always shown, sourced from question bank */}
      {answer && options && (
        <div className="bg-white rounded-2xl border-2 border-medical-teal px-4 py-3">
          <p className="text-xs font-semibold text-medical-teal mb-1.5 tracking-wide">📋 參考答案（題庫來源）</p>
          <div className="flex items-start gap-2.5">
            <span className="font-bold text-medical-teal text-base shrink-0 w-5">{answer}</span>
            <span className="text-sm text-gray-700 leading-snug">{options[answer]}</span>
          </div>
        </div>
      )}

      {/* AI explanation */}
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
        <span className="text-xs text-gray-400 ml-1">Claude Haiku</span>
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
