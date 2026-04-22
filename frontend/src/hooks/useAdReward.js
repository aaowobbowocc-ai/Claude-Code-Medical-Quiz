import { useState, useEffect, useCallback, useRef } from 'react'
import { usePlayerStore } from '../store/gameStore'

// ── Config ──────────────────────────────────────────
// Set VITE_REWARDED_AD_SLOT in Vercel env vars after AdSense H5 approval
const AD_CLIENT = 'ca-pub-3134321405509741'
const REWARDED_AD_SLOT = import.meta.env.VITE_REWARDED_AD_SLOT || ''
// Monetag Direct Link URL — disabled during AdSense re-review.
// To restore: change '' back to `import.meta.env.VITE_MONETAG_DIRECT_LINK || 'https://omg10.com/4/10909987'`
const MONETAG_DIRECT_LINK = ''
const DIRECT_LINK_COUNTDOWN_SEC = 15
const REWARD_COINS = 300

// ── Script loaders ──────────────────────────────────
let adScriptLoaded = false
function ensureAdScript() {
  if (adScriptLoaded || !AD_CLIENT || typeof document === 'undefined') return
  if (document.querySelector('script[src*="adsbygoogle"]')) { adScriptLoaded = true; return }
  const s = document.createElement('script')
  s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${AD_CLIENT}`
  s.async = true
  s.crossOrigin = 'anonymous'
  document.head.appendChild(s)
  adScriptLoaded = true
}

let gptLoaded = false
function ensureGPT() {
  if (gptLoaded || typeof document === 'undefined') return
  if (document.querySelector('script[src*="securepubads"]')) { gptLoaded = true; return }
  const s = document.createElement('script')
  s.src = 'https://securepubads.g.doubleclick.net/tag/js/gpt.js'
  s.async = true
  document.head.appendChild(s)
  gptLoaded = true
}

/**
 * Hook for rewarded ad functionality.
 * Returns state & actions for the RewardAdSheet component.
 */
export function useAdReward() {
  const claimAdReward = usePlayerStore(s => s.claimAdReward)
  const getAdRewardInfo = usePlayerStore(s => s.getAdRewardInfo)

  const [phase, setPhase] = useState('idle') // idle | loading | playing | success | error | cooldown | exhausted
  const [countdown, setCountdown] = useState(0)
  const [cooldownSec, setCooldownSec] = useState(0)
  const [info, setInfo] = useState({ watched: 0, remaining: 10, cooldownMs: 0 })
  const timerRef = useRef(null)

  // Refresh info on mount and after state changes
  const refreshInfo = useCallback(() => {
    const i = getAdRewardInfo()
    setInfo(i)
    if (i.remaining <= 0) setPhase('exhausted')
    else if (i.cooldownMs > 0) {
      setPhase('cooldown')
      setCooldownSec(Math.ceil(i.cooldownMs / 1000))
    } else {
      setPhase('idle')
    }
  }, [getAdRewardInfo])

  useEffect(() => { refreshInfo() }, [refreshInfo])

  // Cooldown timer
  useEffect(() => {
    if (phase !== 'cooldown') return
    const id = setInterval(() => {
      setCooldownSec(prev => {
        if (prev <= 1) {
          clearInterval(id)
          refreshInfo()
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [phase, refreshInfo])

  const showAd = useCallback(async () => {
    const preCheck = getAdRewardInfo()
    if (preCheck.remaining <= 0) { setPhase('exhausted'); return false }
    if (preCheck.cooldownMs > 0) { setPhase('cooldown'); setCooldownSec(Math.ceil(preCheck.cooldownMs / 1000)); return false }

    setPhase('loading')

    // If we have a real rewarded ad slot, use AdSense H5 via GPT
    if (REWARDED_AD_SLOT) {
      try {
        setPhase('playing')
        const rewarded = await showAdSenseRewarded()
        if (rewarded) {
          const result = claimAdReward()
          if (result.success) { setPhase('success'); refreshInfo(); return true }
          setPhase(result.reason === 'cooldown' ? 'cooldown' : 'exhausted')
          return false
        }
        setPhase('error')
        return false
      } catch {
        setPhase('error')
        return false
      }
    }

    // Monetag Direct Link fallback: open ad URL in new tab, 15-second countdown
    // in our tab. Monetag counts the impression once the URL loads, so the
    // countdown is primarily a UX beat + anti-spam guard. User can freely
    // switch back to our tab during the wait.
    if (MONETAG_DIRECT_LINK) {
      // In installed PWA mode, window.open often returns null even when the tab
      // opens successfully (COOP / standalone isolation). So we can't rely on
      // the return value — trust the call unless it throws, and let the daily
      // 10/view + 5min cooldown gate guard against abuse.
      try {
        window.open(MONETAG_DIRECT_LINK, '_blank', 'noopener,noreferrer')
      } catch {
        setPhase('error')
        return false
      }
      setPhase('playing')
      setCountdown(DIRECT_LINK_COUNTDOWN_SEC)
      return new Promise(resolve => {
        let t = DIRECT_LINK_COUNTDOWN_SEC
        timerRef.current = setInterval(() => {
          t--
          setCountdown(t)
          if (t <= 0) {
            clearInterval(timerRef.current)
            const result = claimAdReward()
            if (result.success) {
              setPhase('success')
              refreshInfo()
              resolve(true)
            } else {
              setPhase(result.reason === 'cooldown' ? 'cooldown' : 'exhausted')
              resolve(false)
            }
          }
        }, 1000)
      })
    }

    // Simulation mode (local dev with no ad URL): 3-second countdown
    setPhase('playing')
    setCountdown(3)
    return new Promise(resolve => {
      let t = 3
      timerRef.current = setInterval(() => {
        t--
        setCountdown(t)
        if (t <= 0) {
          clearInterval(timerRef.current)
          const result = claimAdReward()
          if (result.success) {
            setPhase('success')
            refreshInfo()
            resolve(true)
          } else {
            setPhase(result.reason === 'cooldown' ? 'cooldown' : 'exhausted')
            resolve(false)
          }
        }
      }, 1000)
    })
  }, [claimAdReward, getAdRewardInfo, refreshInfo])

  // Cleanup timer on unmount
  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current) }, [])

  return {
    phase, setPhase,
    countdown,        // simulation countdown seconds
    cooldownSec,      // cooldown remaining seconds
    info,             // { watched, remaining, cooldownMs }
    showAd,           // trigger ad
    refreshInfo,      // manually refresh
    rewardCoins: REWARD_COINS,
    isSimulation: !REWARDED_AD_SLOT && !MONETAG_DIRECT_LINK,
  }
}

// ── AdSense H5 Rewarded Ad via GPT ──────────────────
async function showAdSenseRewarded() {
  ensureGPT()

  // Wait for googletag to be ready
  await new Promise(resolve => {
    const check = () => window.googletag?.apiReady ? resolve() : setTimeout(check, 100)
    check()
  })

  return new Promise((resolve, reject) => {
    const googletag = window.googletag
    googletag.cmd.push(() => {
      const slot = googletag.defineOutOfPageSlot(
        REWARDED_AD_SLOT,
        googletag.enums.OutOfPageFormat.REWARDED
      )
      if (!slot) { reject(new Error('slot_unavailable')); return }

      slot.addService(googletag.pubads())

      let settled = false
      const settle = (val) => { if (!settled) { settled = true; resolve(val) } }

      googletag.pubads().addEventListener('rewardedSlotReady', (evt) => {
        evt.makeRewardedVisible()
      })
      googletag.pubads().addEventListener('rewardedSlotGranted', () => settle(true))
      googletag.pubads().addEventListener('rewardedSlotClosed', () => settle(false))

      googletag.enableServices()
      googletag.display(slot)
    })

    // Timeout after 30s
    setTimeout(() => reject(new Error('timeout')), 30000)
  })
}

export default useAdReward
