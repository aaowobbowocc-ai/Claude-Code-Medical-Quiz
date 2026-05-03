import { useState } from 'react'
import Sheet from './Sheet'
import CoinAnimation from './CoinAnimation'
import { usePlayerStore } from '../store/gameStore'

const TIERS = [
  {
    id: 'small',
    label: '小額贊助',
    emoji: '☕',
    price: 15,
    coins: 2000,
    tag: null,
  },
  {
    id: 'medium',
    label: '一般贊助',
    emoji: '🙏',
    price: 50,
    coins: 8000,
    tag: '最受歡迎',
  },
  {
    id: 'large',
    label: '大力贊助',
    emoji: '🏆',
    price: 150,
    coins: 28000,
    tag: '超值',
  },
]

export default function CoinShopSheet({ onClose }) {
  const addCoins = usePlayerStore(s => s.addCoins)
  const [step, setStep] = useState('select') // select | confirm | processing | success
  const [selected, setSelected] = useState(null)
  const [showCoinAnim, setShowCoinAnim] = useState(false)

  const tier = TIERS.find(t => t.id === selected)

  const handleConfirm = () => {
    setStep('processing')
    // 模擬付款處理（demo 用）
    setTimeout(() => {
      if (tier) addCoins(tier.coins)
      setStep('success')
      setShowCoinAnim(true)
    }, 2000)
  }

  const handleClose = () => {
    setStep('select')
    setSelected(null)
    setShowCoinAnim(false)
    onClose()
  }

  return (
    <>
      <Sheet onClose={step === 'processing' ? undefined : handleClose}>

        {/* ── 步驟 1：選擇方案 ── */}
        {step === 'select' && (
          <>
            <div className="text-center mb-5">
              <div className="text-5xl mb-3">🪙</div>
              <h2 className="text-xl font-bold text-medical-dark">贊助國考知識王</h2>
              <p className="text-gray-400 text-sm mt-2 leading-relaxed">
                這是一個由醫學生維護的免費考古題平台。<br />
                贊助將用於伺服器與 AI 解析功能維護。
              </p>
            </div>

            <div className="bg-blue-50 rounded-2xl px-4 py-3 mb-5 text-xs text-blue-700 leading-relaxed space-y-1">
              <p>🖥️ 伺服器費用，讓大家隨時連得到</p>
              <p>🤖 AI 解說功能，看懂每一道考題</p>
              <p>📚 題庫持續更新，緊跟最新考試</p>
            </div>

            <p className="text-xs text-gray-400 mb-3 text-center">作為感謝，贊助可獲得以下金幣用於 AI 解析等功能</p>

            <div className="flex flex-col gap-3 mb-5">
              {TIERS.map(t => (
                <button
                  key={t.id}
                  onClick={() => setSelected(t.id)}
                  className={`relative w-full flex items-center justify-between px-4 py-3.5 rounded-2xl border-2 transition-all active:scale-[0.98] text-left ${
                    selected === t.id
                      ? 'border-medical-blue bg-blue-50'
                      : 'border-gray-200 bg-white'
                  }`}
                >
                  {t.tag && (
                    <span className="absolute -top-2.5 right-3 bg-medical-blue text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
                      {t.tag}
                    </span>
                  )}
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{t.emoji}</span>
                    <div>
                      <p className="font-bold text-medical-dark text-sm">{t.label}</p>
                      <p className="text-amber-600 text-xs font-semibold">🪙 {t.coins.toLocaleString()} 金幣</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-medical-dark text-lg">NT${t.price}</p>
                  </div>
                </button>
              ))}
            </div>

            <button
              onClick={() => selected && setStep('confirm')}
              disabled={!selected}
              className="w-full py-4 rounded-2xl font-bold text-lg text-white active:scale-95 transition-transform disabled:opacity-30 grad-cta"
            >
              下一步
            </button>
          </>
        )}

        {/* ── 步驟 2：確認付款 ── */}
        {step === 'confirm' && tier && (
          <>
            <div className="text-center mb-5">
              <div className="text-5xl mb-3">{tier.emoji}</div>
              <h2 className="text-xl font-bold text-medical-dark">確認贊助內容</h2>
            </div>

            <div className="bg-gray-50 rounded-2xl px-4 py-4 mb-5 space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">方案</span>
                <span className="font-bold text-medical-dark">{tier.label}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">感謝金幣</span>
                <span className="font-bold text-amber-600">🪙 {tier.coins.toLocaleString()} 金幣</span>
              </div>
              <div className="border-t border-gray-200 pt-3 flex justify-between">
                <span className="text-gray-500">付款金額</span>
                <span className="font-bold text-medical-dark text-lg">NT${tier.price}</span>
              </div>
            </div>

            <div className="bg-white border-2 border-gray-100 rounded-2xl px-4 py-3 mb-5 flex items-center gap-3">
              <img
                src="https://www.jkos.com/img/jkopay-logo.svg"
                alt="街口支付"
                className="h-7 object-contain"
                onError={e => { e.target.style.display = 'none' }}
              />
              <div>
                <p className="text-sm font-bold text-gray-700">街口支付</p>
                <p className="text-xs text-gray-400">安全加密付款</p>
              </div>
            </div>

            <p className="text-[11px] text-gray-400 text-center mb-4 leading-relaxed">
              點擊付款即表示同意本平台服務條款。<br />
              金幣將於付款完成後立即存入帳戶。
            </p>

            <button
              onClick={handleConfirm}
              className="w-full py-4 rounded-2xl font-bold text-lg text-white active:scale-95 transition-transform grad-cta mb-2"
            >
              確認付款 NT${tier.price}
            </button>
            <button
              onClick={() => setStep('select')}
              className="w-full py-2.5 rounded-2xl text-sm text-gray-400 active:bg-gray-50"
            >
              返回修改
            </button>
          </>
        )}

        {/* ── 步驟 3：處理中 ── */}
        {step === 'processing' && (
          <div className="text-center py-8">
            <div className="text-5xl mb-4 animate-pulse">⏳</div>
            <p className="font-bold text-medical-dark text-lg">付款處理中</p>
            <p className="text-gray-400 text-sm mt-2">請稍候，勿關閉此頁面...</p>
          </div>
        )}

        {/* ── 步驟 4：成功 ── */}
        {step === 'success' && tier && (
          <div className="text-center py-4">
            <div className="text-5xl mb-3">🎉</div>
            <h2 className="text-xl font-bold text-medical-dark mb-1">感謝你的贊助！</h2>
            <p className="text-gray-400 text-sm leading-relaxed mb-5">
              正是有你的支持，<br />這個平台才能持續免費提供給所有備考的同學。
            </p>
            <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-4 mb-5">
              <p className="text-amber-700 font-bold text-lg">
                🪙 +{tier.coins.toLocaleString()} 金幣已存入帳戶
              </p>
            </div>
            <button onClick={handleClose}
              className="px-10 py-3 rounded-2xl font-bold text-white active:scale-95 grad-cta">
              繼續練習
            </button>
          </div>
        )}

      </Sheet>

      {showCoinAnim && <CoinAnimation onDone={() => setShowCoinAnim(false)} />}
    </>
  )
}
