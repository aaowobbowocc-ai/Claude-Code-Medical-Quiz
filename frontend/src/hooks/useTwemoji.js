import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import twemoji from '@twemoji/api'

// CDN for Twemoji SVG assets. jsdelivr 全球節點穩定，第一次載入後瀏覽器會快取。
// 不 bundle 進 App 因為 SVG 總和 ~10MB，不值得。
const TWEMOJI_BASE = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/'

function parseAll(node) {
  if (!node) return
  twemoji.parse(node, {
    folder: 'svg',
    ext: '.svg',
    base: TWEMOJI_BASE,
    className: 'twemoji',
  })
}

/**
 * 把頁面 emoji 換成 Twemoji SVG。解決 Android 9 以下/舊 iOS 看不到新 emoji 的問題
 * (🩺 🪙 🥹 等 Emoji 12+ 在舊系統會顯示成豆腐方框)。
 *
 * - 路由切換時重跑 (lazy-loaded 頁面)
 * - MutationObserver 處理動態 modal/sheet/吐司
 */
export function useTwemoji() {
  const { pathname } = useLocation()

  // 路由切換時重跑一次 (覆蓋 lazy-load 進來的頁面 markup)
  useEffect(() => {
    // 等下一個 tick 讓 React 把 lazy chunk 渲染好
    const t = setTimeout(() => parseAll(document.body), 0)
    return () => clearTimeout(t)
  }, [pathname])

  // MutationObserver: Sheet / Modal / Toast 等動態節點塞進 DOM 時也要 parse
  useEffect(() => {
    // 初次掛載先全跑一次 (覆蓋 pathname effect 觸發前的內容)
    parseAll(document.body)

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) parseAll(node)
        }
      }
    })

    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
}
