import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Footer from '../components/Footer'
import { usePageMeta } from '../hooks/usePageMeta'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

export default function Contact() {
  const navigate = useNavigate()
  usePageMeta('關於我們', '國考知識王：醫學生獨立開發的免費醫事國考練習平台，65,000+ 題、即時對戰、AI 解說。')
  const [feedbackText, setFeedbackText] = useState('')
  const [sent, setSent] = useState(false)
  const [sending, setSending] = useState(false)

  const handleSend = async () => {
    if (!feedbackText.trim() || sending) return
    setSending(true)
    try {
      const res = await fetch(`${BACKEND}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: feedbackText }),
      })
      if (res.ok) setSent(true)
    } catch { /* ignore */ }
    setSending(false)
  }

  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      <div className="grad-header px-5 pt-14 pb-6">
        <button onClick={() => navigate(-1)}
                className="absolute top-4 left-3 text-white/70 text-sm flex items-center gap-1 active:scale-95">
          ← 返回
        </button>
        <h1 className="text-white font-bold text-2xl text-center">關於我們</h1>
        <p className="text-white/50 text-sm text-center mt-1">About / Contact</p>
      </div>

      <div className="flex-1 px-5 py-6 space-y-5">
        {/* About */}
        <div className="bg-white rounded-2xl shadow-sm p-6 text-sm text-gray-700 leading-relaxed space-y-4">
          <div className="text-center">
            <div className="text-5xl mb-3">⚕️</div>
            <h2 className="font-bold text-xl text-medical-dark">國考知識王</h2>
            <p className="text-gray-400 text-sm mt-1">醫事人員國考題庫對戰練習平台</p>
          </div>

          <div className="h-px bg-gray-100" />

          <section>
            <h3 className="font-bold text-base text-medical-dark mb-2">我們的理念</h3>
            <p>
              「國考知識王」由一位醫學系學生獨立開發，深知備考國考的辛苦。
              我們相信每位努力的考生都值得一個免費、好用的練習工具。
            </p>
            <p className="mt-2">
              這個平台誕生的初衷很簡單——讓枯燥的國考複習變得有趣一點。
              透過即時對戰、AI 解說、錯題複習等功能，幫助你在互動中學習，在挑戰中成長。
            </p>
          </section>

          <section>
            <h3 className="font-bold text-base text-medical-dark mb-2">平台特色</h3>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>7900+ 考古題：</strong>涵蓋 110–115 年醫師、牙醫師、藥師國考歷屆題目</li>
              <li><strong>三大國考類別：</strong>醫師（一階+二階）、牙醫師（一階+二階）、藥師（一階+二階）</li>
              <li><strong>即時對戰：</strong>與好友或 AI 即時搶答，讓讀書不再孤單</li>
              <li><strong>AI 題目解說：</strong>每題都有 AI 生成的詳細解析，幫你理解觀念</li>
              <li><strong>模擬考試：</strong>完全模擬真實國考流程，依各科及格制評分</li>
              <li><strong>錯題複習：</strong>自動記錄錯題，搭配間隔複習，越練越強</li>
              <li><strong>完全免費：</strong>所有核心功能永久免費，不需註冊帳號</li>
            </ul>
          </section>

          <section>
            <h3 className="font-bold text-base text-medical-dark mb-2">開發者</h3>
            <p>
              本平台由一位熱愛程式開發的醫學系學生獨立設計與開發，持續更新維護中。
              如果這個工具對你有幫助，歡迎分享給更多需要的同學！（醫學系、牙醫系、藥學系都適用）
            </p>
          </section>
        </div>

        {/* Contact Form */}
        <div className="bg-white rounded-2xl shadow-sm p-6 text-sm text-gray-700 leading-relaxed">
          <h3 className="font-bold text-base text-medical-dark mb-3">聯絡我們</h3>
          {sent ? (
            <div className="text-center py-4">
              <div className="text-4xl mb-2">🙏</div>
              <p className="font-bold text-medical-dark">感謝您的回饋！</p>
              <p className="text-gray-400 text-sm mt-1">每一條訊息我都會認真讀。</p>
            </div>
          ) : (
            <>
              <p className="text-gray-400 mb-3">
                題目有誤、功能建議、Bug 回報，什麼都可以告訴我們：
              </p>
              <textarea
                className="w-full border-2 border-gray-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-medical-blue resize-none mb-3"
                rows={4}
                placeholder="請輸入您的意見或問題..."
                value={feedbackText}
                onChange={e => setFeedbackText(e.target.value)}
              />
              <button
                onClick={handleSend}
                disabled={!feedbackText.trim() || sending}
                className="w-full py-3.5 rounded-2xl font-bold text-white active:scale-95 transition-transform disabled:opacity-40 grad-cta"
              >
                {sending ? '送出中...' : '送出意見'}
              </button>
            </>
          )}
        </div>

      </div>

      <Footer />
    </div>
  )
}
