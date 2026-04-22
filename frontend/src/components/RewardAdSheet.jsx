import { useState } from 'react'
import Sheet from './Sheet'
import CoinAnimation from './CoinAnimation'
import { useAdReward } from '../hooks/useAdReward'

function formatCooldown(sec) {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// Toggle the whole feature off without a code push by flipping this flag.
// Enabled via Monetag Direct Link (15-sec countdown, 300 coins/view, 10/day).
const AD_REWARD_ENABLED = true

export default function RewardAdSheet({ onClose }) {
  const { phase, setPhase, countdown, cooldownSec, info, showAd, refreshInfo, rewardCoins, isSimulation } = useAdReward()
  const [showCoinAnim, setShowCoinAnim] = useState(false)

  const handleWatch = async () => {
    const ok = await showAd()
    if (ok) setShowCoinAnim(true)
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
            <p className="text-amber-500 text-xs mt-1">每日最多 2 次，敬請期待</p>
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
            觀看廣告即可獲得金幣<br />每天最多 2 次
          </p>
        </div>

        {/* Reward info box */}
        <div className="bg-amber-50 rounded-2xl px-4 py-4 mb-5 text-center">
          <p className="text-amber-800 font-bold text-lg">🪙 看廣告獲得 {rewardCoins} 金幣</p>
          <p className="text-amber-600/70 text-sm mt-1">今日已看 {info.watched}/2 次 · 剩餘 {info.remaining} 次</p>
        </div>

        {/* Phase-specific content */}
        {phase === 'idle' && (
          <button onClick={handleWatch}
            className="w-full py-4 rounded-2xl font-bold text-lg text-white active:scale-95 transition-transform grad-cta">
            ▶ 觀看廣告領取金幣
          </button>
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
            <p className="text-gray-400 text-sm mt-1">明天再來領取吧！</p>
          </div>
        )}

        {phase === 'error' && (
          <div className="text-center">
            <div className="w-full py-4 rounded-2xl bg-red-50 border border-red-200 mb-3">
              <p className="text-red-600 font-bold">廣告載入失敗</p>
              <p className="text-red-400 text-sm mt-1">
                可能是瀏覽器擋彈出視窗，請允許後再試
              </p>
            </div>
            <button onClick={() => { setPhase('idle'); refreshInfo() }}
              className="mt-2 px-6 py-2 rounded-xl text-sm font-bold text-gray-500 bg-gray-100 active:scale-95">
              重試
            </button>
          </div>
        )}

        <p className="text-center text-xs text-gray-300 mt-4">
          廣告收益將全數用於維護伺服器與題庫更新
        </p>
      </Sheet>

      {showCoinAnim && <CoinAnimation onDone={handleDone} />}
    </>
  )
}
