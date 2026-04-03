import { useState } from 'react'
import Sheet from './Sheet'

const CONTACT_MAIL = 'aaowobbowocc@gmail.com'

export default function SupportSheets({ sheet, setSheet }) {
  const [feedbackText, setFeedbackText] = useState('')
  const [feedbackSent, setFeedbackSent] = useState(false)

  const sendContact = () => {
    if (!feedbackText.trim()) return
    const subj = encodeURIComponent('醫學知識王 意見／回報')
    const body = encodeURIComponent(feedbackText)
    window.open(`mailto:${CONTACT_MAIL}?subject=${subj}&body=${body}`)
    setFeedbackSent(true)
  }

  return (
    <>
      {sheet === 'donate' && (
        <Sheet onClose={() => setSheet(null)}>
          <div className="text-center mb-5">
            <div className="text-5xl mb-3">☕</div>
            <h2 className="text-xl font-bold text-medical-dark">支持這個計畫</h2>
            <p className="text-gray-400 text-sm mt-2 leading-relaxed">
              「免費」是這裡的核心。<br />
              每位努力備考的醫學生，都值得一個好用的練習工具。
            </p>
          </div>

          <div className="bg-amber-50 rounded-2xl px-4 py-4 mb-5 text-sm text-amber-800 leading-relaxed space-y-1.5">
            <p>你的贊助會直接用於：</p>
            <p>🖥️ 伺服器費用，讓大家隨時連得到</p>
            <p>🤖 AI 解說功能，看懂每一道題</p>
            <p>📚 題庫持續更新，緊跟最新考試</p>
          </div>

          <div className="w-full py-4 rounded-2xl text-center mb-3 bg-gray-100 border-2 border-dashed border-gray-300">
            <p className="text-base font-bold text-gray-500">🔧 收款功能審核中</p>
            <p className="text-xs text-gray-400 mt-1">很快就好，感謝你的耐心等待 🙏</p>
          </div>

          <p className="text-center text-xs text-gray-300 leading-relaxed">
            不贊助也完全沒關係 🙏<br />這裡永遠為你開著。
          </p>
        </Sheet>
      )}

      {sheet === 'contact' && (
        <Sheet onClose={() => { setSheet(null); setFeedbackSent(false); setFeedbackText('') }}>
          {feedbackSent ? (
            <div className="text-center py-6">
              <div className="text-6xl mb-4">🙏</div>
              <h2 className="text-xl font-bold text-medical-dark mb-2">謝謝你！</h2>
              <p className="text-gray-400 text-sm leading-relaxed">
                每一條訊息我都會認真讀。<br />
                正是這樣的回饋讓這個專案繼續走下去。
              </p>
              <button onClick={() => { setSheet(null); setFeedbackSent(false); setFeedbackText('') }}
                      className="mt-6 px-8 py-3 rounded-2xl font-bold text-white active:scale-95 grad-cta">
                關閉
              </button>
            </div>
          ) : (
            <>
              <div className="text-center mb-5">
                <div className="text-5xl mb-3">💌</div>
                <h2 className="text-xl font-bold text-medical-dark">聯絡開發者</h2>
                <p className="text-gray-400 text-sm mt-1.5 leading-relaxed">
                  意見回饋、功能建議、題目有誤——<br />
                  什麼都可以說，我都想聽。
                </p>
              </div>
              <textarea
                autoFocus
                className="w-full border-2 border-gray-200 rounded-2xl px-4 py-3.5 text-sm text-gray-700 outline-none focus:border-medical-blue resize-none mb-4 leading-relaxed"
                rows={5}
                placeholder="例如：113年第一次第42題答案有疑義、希望新增某功能、或只是說聲謝謝……"
                value={feedbackText}
                onChange={e => setFeedbackText(e.target.value)}
              />
              <button
                onClick={sendContact}
                disabled={!feedbackText.trim()}
                className="w-full py-4 rounded-2xl font-bold text-lg text-white active:scale-95 transition-transform disabled:opacity-40 grad-cta"
              >
                以 Email 送出
              </button>
            </>
          )}
        </Sheet>
      )}
    </>
  )
}
