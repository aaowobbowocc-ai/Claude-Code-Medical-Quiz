import { useState } from 'react'
import Sheet from './Sheet'
import CoinAnimation from './CoinAnimation'
import { useAdReward } from '../hooks/useAdReward'
import { isNativeApp } from '../lib/admob'

function formatCooldown(sec) {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// Toggle the whole feature off without a code push by flipping this flag.
// Enabled via Monetag Direct Link (15-sec countdown, 300 coins/view, 10/day).
const AD_REWARD_ENABLED = true

// Web 端暫不開放 Monetag/AdSense 看廣告領金幣 — 2026-06-03 決定等 App 上線
// 一起推。Native (Android/iOS App) 仍走 AdMob Rewarded 正常運作。
const IS_NATIVE = isNativeApp()

export default function RewardAdSheet({ onClose, onOpenShop }) {
  const { phase, setPhase, failReason, countdown, cooldownSec, info, showAd, getAdUrl, refreshInfo, rewardCoins, isSimulation } = useAdReward()
  const [showCoinAnim, setShowCoinAnim] = useState(false)

  // Web 端預告：等 App 上線時開放 (Android 內測中、iOS Apple Developer 審核中)
  if (!IS_NATIVE) {
    return (
      <Sheet onClose={onClose}>
        <div className="text-center py-4">
          <div className="text-5xl mb-3">📱</div>
          <h2 className="text-xl font-bold text-medical-dark">觀看廣告領金幣</h2>
          <p className="text-gray-400 text-sm mt-3 leading-relaxed">
            此功能將在 App 版上線時一起開放！
          </p>
          <div className="bg-amber-50 rounded-2xl px-4 py-4 mt-4 mb-4">
            <p className="text-amber-700 text-sm font-medium">🎬 Android / iOS App 即將推出</p>
            <p className="text-amber-500 text-xs mt-1">每次觀看可獲得 300 金幣，每日最多 10 次</p>
          </div>
          {onOpenShop && (
            <button onClick={() => { onClose(); onOpenShop() }}
              className="w-full py-3 rounded-2xl font-bold text-sm text-amber-700 bg-amber-50 border border-amber-200 active:scale-95 mb-2">
              ☕ 想立即取得金幣？前往金幣商店
            </button>
          )}
          <button onClick={onClose}
            className="w-full py-3 rounded-2xl font-bold text-gray-500 border border-gray-200 active:scale-95">
            知道了
          </button>
        </div>
      </Sheet>
    )
  }

  // Open the ad window SYNCHRONOUSLY inside the click handler so the browser
  // still treats it as a user gesture (avoids desktop popup blocker).
  const handleWatch = () => {
    let windowOpened = false
    const url = getAdUrl()
    if (url) {
      try {
        const w = window.open(url, '_blank', 'noopener,noreferrer')
        windowOpened = !!w
      } catch {}
    }
    showAd(windowOpened).then(ok => { if (ok) setShowCoinAnim(true) })
  }

  const handleDone = () => {
    setShowCoinAnim(false)
    refreshInfo()
  }

  // Feature not yet available — show coming soon notice
  if (!AD_REWARD_ENABLED) {
    return (
      <Sheet onClose={onClose}>
        <div className="text-center py-4">
          <div className="text-5xl mb-3">🎬</div>
          <h2 className="text-xl font-bold text-medical-dark">看廣告領金幣</h2>
          <p className="text-gray-400 text-sm mt-3 leading-relaxed">
            此功能目前正在準備中，即將開放！
          </p>
          <div className="bg-amber-50 rounded-2xl px-4 py-4 mt-4 mb-4">
            <p className="text-amber-700 text-sm font-medium">每次觀看可獲得 300 金幣</p>
            <p className="text-amber-500 text-xs mt-1">每日最多 10 次，敬請期待</p>
          </div>
          <button onClick={onClose}
            className="px-8 py-3 rounded-2xl font-bold text-white active:scale-95 grad-cta">
            知道了
          </button>
        </div>
      </Sheet>
    )
  }

  return (
    <>
      <Sheet onClose={onClose}>
        <div className="text-center mb-5">
          <div className="text-5xl mb-3">🎬</div>
          <h2 className="text-xl font-bold text-medical-dark">免費領取金幣</h2>
          <p className="text-gray-400 text-sm mt-2 leading-relaxed">
            觀看廣告即可獲得金幣<br />每天最多 10 次
          </p>
        </div>

        {/* Reward info box */}
        <div className="bg-amber-50 rounded-2xl px-4 py-4 mb-5 text-center">
          <p className="text-amber-800 font-bold text-lg">🪙 看廣告獲得 {rewardCoins} 金幣</p>
          <p className="text-amber-600/70 text-sm mt-1">今日已看 {info.watched}/10 次 · 剩餘 {info.remaining} 次</p>
        </div>

        {/* Phase-specific content */}
        {phase === 'idle' && (
          <>
            <button onClick={handleWatch}
              className="w-full py-4 rounded-2xl font-bold text-lg text-white active:scale-95 transition-transform grad-cta">
              ▶ 觀看廣告領取金幣
            </button>
            {onOpenShop && (
              <div className="flex items-center gap-3 my-3">
                <div className="flex-1 h-px bg-gray-100" />
                <span className="text-xs text-gray-300">或</span>
                <div className="flex-1 h-px bg-gray-100" />
              </div>
            )}
            {onOpenShop && (
              <button onClick={() => { onClose(); onOpenShop() }}
                className="w-full py-3 rounded-2xl font-bold text-sm text-amber-600 bg-amber-50 border border-amber-200 active:scale-95 transition-transform">
                🪙 金幣商店 — 贊助支持獲得更多金幣
              </button>
            )}
          </>
        )}

        {phase === 'loading' && (
          <div className="w-full py-4 rounded-2xl text-center bg-gray-100">
            <p className="text-gray-500 font-bold">載入廣告中...</p>
          </div>
        )}

        {phase === 'playing' && (
          <div className="w-full py-6 rounded-2xl text-center bg-gray-900">
            <p className="text-white text-sm mb-2">
              {isSimulation ? '模擬廣告播放中' : '廣告已在新分頁開啟'}
            </p>
            <p className="text-white font-bold text-4xl">{countdown}</p>
            <p className="text-white/50 text-xs mt-2">
              {isSimulation ? '請稍候...' : '倒數結束即可領取金幣'}
            </p>
          </div>
        )}

        {phase === 'success' && (
          <div className="text-center py-4">
            <div className="text-5xl mb-3">🎉</div>
            <p className="text-medical-dark font-bold text-lg">獲得 {rewardCoins} 金幣！</p>
            <p className="text-gray-400 text-sm mt-1">剩餘 {info.remaining} 次</p>
            <button onClick={() => { setPhase('idle'); refreshInfo() }}
              className="mt-4 px-8 py-3 rounded-2xl font-bold text-white active:scale-95 grad-cta">
              {info.remaining > 0 ? '繼續領取' : '關閉'}
            </button>
          </div>
        )}

        {phase === 'cooldown' && (
          <div className="text-center">
            <div className="w-full py-4 rounded-2xl bg-gray-50 border border-gray-200 mb-3">
              <p className="text-gray-500 text-sm">冷卻中</p>
              <p className="text-gray-700 font-bold text-2xl mt-1">⏰ {formatCooldown(cooldownSec)}</p>
            </div>
            <p className="text-gray-300 text-xs">每次觀看需間隔 5 分鐘</p>
          </div>
        )}

        {phase === 'exhausted' && (
          <div className="text-center py-4">
            <div className="text-5xl mb-3">😴</div>
            <p className="text-gray-600 font-bold">今天已達上限</p>
            <p className="text-gray-400 text-sm mt-1 mb-4">明天再來領取吧！</p>
            {onOpenShop && (
              <button onClick={() => { onClose(); onOpenShop() }}
                className="px-6 py-3 rounded-2xl font-bold text-sm text-amber-600 bg-amber-50 border border-amber-200 active:scale-95 transition-transform">
                ☕ 贊助支持，立即獲得金幣
              </button>
            )}
          </div>
        )}

        {phase === 'error' && (() => {
          // 依失敗原因給對的訊息，不要把「沒登入/網路/同步」全講成「廣告載入失敗」
          const msg = {
            no_auth:    { title: '請先登入', body: '登入後才能領取金幣，你的進度與金幣也會一起保存' },
            no_profile: { title: '帳號資料同步中', body: '請稍候幾秒再按重試' },
            network:    { title: '網路連線有問題', body: '請檢查網路後再試一次' },
          }[failReason] || {
            title: '廣告載入失敗',
            body: IS_NATIVE ? '請稍後再試一次' : '可能是瀏覽器擋彈出視窗，請允許後再試',
          }
          return (
            <div className="text-center">
              <div className="w-full py-4 rounded-2xl bg-red-50 border border-red-200 mb-3">
                <p className="text-red-600 font-bold">{msg.title}</p>
                <p className="text-red-400 text-sm mt-1">{msg.body}</p>
              </div>
              <button onClick={() => { setPhase('idle'); refreshInfo() }}
                className="mt-2 px-6 py-2 rounded-xl text-sm font-bold text-gray-500 bg-gray-100 active:scale-95">
                重試
              </button>
            </div>
          )
        })()}

        <p className="text-center text-xs text-gray-300 mt-4">
          廣告收益將全數用於維護伺服器與題庫更新
        </p>
      </Sheet>

      {showCoinAnim && <CoinAnimation onDone={handleDone} />}
    </>
  )
}
