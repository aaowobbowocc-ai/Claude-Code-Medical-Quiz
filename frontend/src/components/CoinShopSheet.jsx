import { useState, useEffect, useRef } from 'react'
import Sheet from './Sheet'
import { usePlayerStore } from '../store/gameStore'
import { readAuthFromStorage } from '../lib/supabase'
import { getDeviceId } from '../hooks/useAI'
import { isNativeApp } from '../lib/admob'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

// 2026-05-27: Android App 版完全隱藏付費入口避 Google Play Policy 退件。
// （Google Play 對「數位內容外部金流」嚴格管控，所有 App 內購買的虛擬貨幣
//  原則上必須走 Play Billing 抽 15-30%。我們現階段選擇純廣告賺幣，付費
//  贊助僅在 web 版開放。）
const IS_NATIVE = isNativeApp()

const TIERS = [
  {
    id: 'small',
    label: '小額贊助',
    emoji: '☕',
    price: 15,
    coins: 2500,
    tag: null,
  },
  {
    id: 'medium',
    label: '一般贊助',
    emoji: '🙏',
    price: 50,
    coins: 10000,
    tag: '最受歡迎',
  },
  {
    id: 'large',
    label: '大力贊助',
    emoji: '🏆',
    price: 150,
    coins: 35000,
    tag: '超值',
  },
]

export default function CoinShopSheet({ onClose }) {
  const [step, setStep] = useState('select') // select | confirm | processing | success | error
  const [selected, setSelected] = useState(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [orderId, setOrderId] = useState(null)
  const [payUrl, setPayUrl] = useState('')
  const pollRef = useRef(null)

  const tier = TIERS.find(t => t.id === selected)

  const handleConfirm = async () => {
    setStep('processing')
    setErrorMsg('')
    // 在「使用者點擊」這個手勢內同步先開一個空白分頁——這樣不會被瀏覽器當彈窗擋掉。
    // （若等 await 建單後才 window.open，會脫離手勢被擋。）建單後再把它導向街口付款頁，
    // 主畫面留在原地輪詢狀態，使用者付完回來這頁會自動顯示成功。
    // 注意：不能帶 noopener，否則回傳 null 拿不到分頁參考無法導向。
    const payWin = window.open('about:blank', '_blank')
    try {
      // 直接從 localStorage 讀登入狀態：supabase.auth.getSession() 可能 hang 卡住付款流程。
      const { user_id } = readAuthFromStorage()
      if (!user_id) {
        if (payWin && !payWin.closed) payWin.close()
        setErrorMsg('請先登入帳號才能領取金幣')
        setStep('error')
        return
      }
      const device_id = getDeviceId()

      // 後端建單 → 回傳街口付款頁 URL
      const r = await fetch(`${BACKEND}/payment/jkos/create-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: selected, user_id, device_id }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j.error || j.detail || `HTTP ${r.status}`)
      }
      const { order_id, payment_url } = await r.json()
      setOrderId(order_id)
      setPayUrl(payment_url)

      // 把先前同步開好的分頁導向街口付款頁；若被擋(payWin 為 null)使用者可點下方手動連結。
      if (payWin && !payWin.closed) payWin.location.href = payment_url

      // 主畫面每 3 秒輪詢交易狀態（最多 10 分鐘），付款完成自動顯示成功
      let attempts = 0
      const maxAttempts = 200
      pollRef.current = setInterval(async () => {
        attempts++
        try {
          const sr = await fetch(`${BACKEND}/payment/jkos/status/${order_id}`)
          if (sr.ok) {
            const status = await sr.json()
            if (status.status === 'paid') {
              clearInterval(pollRef.current); setStep('success'); return
            }
            if (status.status === 'failed' || status.status === 'expired') {
              clearInterval(pollRef.current)
              setErrorMsg(status.status === 'expired' ? '訂單已過期' : '付款失敗')
              setStep('error'); return
            }
          }
        } catch {}
        if (attempts >= maxAttempts) {
          clearInterval(pollRef.current)
          setErrorMsg('付款逾時，若已扣款金幣會自動入帳')
          setStep('error')
        }
      }, 3000)
    } catch (e) {
      console.error('create-order failed', e)
      if (payWin && !payWin.closed) payWin.close()
      setErrorMsg(e.message || '建立訂單失敗')
      setStep('error')
    }
  }

  // Cleanup polling interval on unmount
  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current)
  }, [])

  const handleClose = () => {
    if (pollRef.current) clearInterval(pollRef.current)
    setStep('select')
    setSelected(null)
    setOrderId(null)
    setErrorMsg('')
    onClose()
  }

  // Android App 版：完全不顯示付費 tier，改成引導使用者用免費方式拿金幣
  if (IS_NATIVE) {
    return (
      <Sheet onClose={handleClose}>
        <div className="text-center mb-5">
          <div className="text-5xl mb-3">🪙</div>
          <h2 className="text-xl font-bold text-medical-dark">取得金幣</h2>
          <p className="text-gray-400 text-sm mt-2 leading-relaxed">
            金幣可用於 AI 解析等進階功能
          </p>
        </div>

        <div className="bg-blue-50 rounded-2xl px-4 py-4 mb-4 text-sm text-blue-800 leading-relaxed space-y-2">
          <p className="font-bold">✨ App 內取得金幣的方式：</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>每日簽到（連續登入加倍）</li>
            <li>看獎勵廣告（每天最多 10 次，每次 300 幣）</li>
            <li>答對題目累積經驗值升等獎勵</li>
            <li>邀請朋友加入</li>
          </ul>
        </div>

        <div className="bg-gray-50 rounded-2xl px-4 py-3 mb-4 text-xs text-gray-500 leading-relaxed">
          <p>📱 想直接贊助平台？</p>
          <p className="mt-1">
            請開電腦或瀏覽器版本進入：<br />
            <span className="font-mono text-medical-blue">examking.tw</span>
          </p>
          <p className="mt-2 text-gray-400">App 版本目前不支援站內付費，是為了讓你免費使用所有功能。</p>
        </div>

        <button
          onClick={handleClose}
          className="w-full py-3 rounded-2xl font-bold text-medical-dark border-2 border-gray-200 active:scale-95 transition-transform"
        >
          知道了
        </button>
      </Sheet>
    )
  }

  return (
    <Sheet onClose={step === 'processing' ? undefined : handleClose}>

        {/* ── 步驟 1：選擇方案 ── */}
        {step === 'select' && (
          <>
            <div className="text-center mb-5">
              <div className="text-5xl mb-3">🪙</div>
              <h2 className="text-xl font-bold text-medical-dark">
                贊助國考知識王
                <span className="ml-2 align-middle text-[11px] font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">測試中</span>
              </h2>
              <p className="text-gray-400 text-sm mt-2 leading-relaxed">
                這是一個由醫學生維護的免費考古題平台。<br />
                贊助將用於伺服器與 AI 解析功能維護。
              </p>
            </div>

            {/* 2026-06-03: 街口支付正式環境上線 (Leona 開通) — 恢復 3 個方案選擇
                Web only (IS_NATIVE 上方 return 已擋 App)。流程：選方案 → confirm →
                processing → success（金幣以 user_coin_grants 入帳，需到通知領取） */}
            <div className="grid gap-3 mb-4">
              {TIERS.map(t => (
                <button
                  key={t.id}
                  onClick={() => { setSelected(t.id); setStep('confirm') }}
                  className="relative w-full rounded-2xl px-4 py-4 bg-white border-2 border-gray-200 active:scale-[0.98] transition-transform text-left flex items-center gap-4 hover:border-amber-300"
                >
                  {t.tag && (
                    <span className="absolute -top-2 right-3 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                      {t.tag}
                    </span>
                  )}
                  <div className="text-3xl shrink-0">{t.emoji}</div>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-medical-dark">{t.label}</p>
                    <p className="text-xs text-amber-600 mt-0.5">🪙 {t.coins.toLocaleString()} 金幣</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold text-medical-dark text-lg">NT${t.price}</p>
                    <p className="text-[10px] text-gray-400">街口支付</p>
                  </div>
                </button>
              ))}
            </div>

            <div className="bg-gray-50 rounded-2xl px-4 py-3 mb-3 text-xs text-gray-500 leading-relaxed space-y-1">
              <p className="font-semibold text-gray-700 mb-1">贊助會用在：</p>
              <p>🖥️ 伺服器費用，讓大家隨時連得到</p>
              <p>🤖 AI 解說功能，看懂每一道考題</p>
              <p>📚 題庫持續更新，緊跟最新考試</p>
            </div>

            <button
              onClick={handleClose}
              className="w-full py-3 rounded-2xl font-bold text-medical-dark border-2 border-gray-200 active:scale-95 transition-transform"
            >
              關閉
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

            <div className="bg-white border-2 border-gray-100 rounded-2xl px-4 py-3.5 mb-5 flex items-center gap-3">
              <img
                src="/jkopay-logo.png"
                alt="街口支付 JKOPAY"
                className="h-10 object-contain"
              />
              <span className="text-xs text-gray-400 ml-auto">安全加密付款</span>
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
            <div className="flex gap-2">
              <button
                onClick={() => setStep('select')}
                className="flex-1 py-2.5 rounded-2xl text-sm text-gray-500 border border-gray-200 active:bg-gray-50"
              >
                返回修改
              </button>
              <button
                onClick={handleClose}
                className="flex-1 py-2.5 rounded-2xl text-sm text-gray-400 active:bg-gray-50"
              >
                不買了
              </button>
            </div>
          </>
        )}

        {/* ── 步驟 3：處理中（新分頁開街口付款頁，主畫面輪詢狀態）── */}
        {step === 'processing' && (
          <div className="text-center py-8">
            <div className="text-5xl mb-4 animate-pulse">⏳</div>
            <p className="font-bold text-medical-dark text-lg">等待付款完成</p>
            <p className="text-gray-400 text-sm mt-2 leading-relaxed">
              已於新分頁開啟街口付款頁。<br />付款完成後此頁會自動更新。
            </p>
            {payUrl && (
              <button
                onClick={() => window.open(payUrl, '_blank')}
                className="mt-4 block mx-auto text-sm font-semibold text-medical-blue underline active:opacity-70"
              >
                付款頁沒有自動開啟？點此開啟 →
              </button>
            )}
            <button
              onClick={handleClose}
              className="mt-5 block mx-auto px-8 py-2.5 rounded-xl font-semibold text-gray-500 bg-gray-100 active:scale-95"
            >
              取消，我不付了
            </button>
          </div>
        )}

        {/* ── 錯誤 ── */}
        {step === 'error' && (
          <div className="text-center py-6">
            <div className="text-5xl mb-3">⚠️</div>
            <h2 className="text-xl font-bold text-medical-dark mb-2">付款失敗</h2>
            <p className="text-gray-500 text-sm mb-5 leading-relaxed">{errorMsg || '未知錯誤'}</p>
            <button
              onClick={() => { setStep('select'); setErrorMsg('') }}
              className="w-full py-3 rounded-2xl font-bold text-white grad-cta active:scale-95 mb-2"
            >
              重新選擇方案
            </button>
            <button onClick={handleClose}
              className="w-full py-2.5 rounded-2xl text-sm text-gray-400 active:bg-gray-50">
              關閉
            </button>
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
                🪙 +{tier.coins.toLocaleString()} 金幣已自動入帳
              </p>
              <p className="text-amber-600 text-xs mt-2">
                感謝你的支持，繼續加油！
              </p>
            </div>
            <button onClick={() => { handleClose(); window.location.reload() }}
              className="px-10 py-3 rounded-2xl font-bold text-white active:scale-95 grad-cta">
              繼續練習
            </button>
          </div>
        )}

      </Sheet>
  )
}
