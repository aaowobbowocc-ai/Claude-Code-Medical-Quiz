import { useEffect } from 'react'

const DEFAULT_TITLE = '國考知識王 — 最專業的醫藥護國考對戰練習平台'
const DEFAULT_DESC = '免費醫事國考題庫，涵蓋醫師、牙醫、藥師、護理師等 21 類考試，75,000+ 題。即時對戰、AI 解說、歷屆模擬考、弱點分析，助你高效備考！'
const DEFAULT_URL = 'https://examking.tw/'
const DEFAULT_IMAGE = 'https://examking.tw/icons/icon-512.png'

function setMeta(selector, attr, value) {
  const el = document.querySelector(selector)
  if (el && value != null) el.setAttribute(attr, value)
}

function setLink(rel, href) {
  let el = document.querySelector(`link[rel="${rel}"]`)
  if (!el) {
    el = document.createElement('link')
    el.setAttribute('rel', rel)
    document.head.appendChild(el)
  }
  if (href) el.setAttribute('href', href)
}

/**
 * Update document head for SEO / social sharing.
 *
 * Legacy signature: usePageMeta(title, description)
 * Extended signature: usePageMeta(title, description, { canonical, ogImage, twitterCard })
 *
 * canonical — absolute URL that search engines should treat as the canonical page.
 *             Also becomes og:url so Threads/FB share preview points back here.
 */
export function usePageMeta(title, description, options = {}) {
  const { canonical, ogImage, twitterCard } = options
  useEffect(() => {
    const finalTitle = title ? `${title} | 國考知識王` : DEFAULT_TITLE
    const finalDesc = description || DEFAULT_DESC
    const finalUrl = canonical || DEFAULT_URL
    const finalImage = ogImage || DEFAULT_IMAGE

    document.title = finalTitle
    setMeta('meta[name="description"]', 'content', finalDesc)
    setMeta('meta[property="og:title"]',       'content', title || DEFAULT_TITLE)
    setMeta('meta[property="og:description"]', 'content', finalDesc)
    setMeta('meta[property="og:url"]',         'content', finalUrl)
    setMeta('meta[property="og:image"]',       'content', finalImage)
    setMeta('meta[name="twitter:title"]',       'content', title || DEFAULT_TITLE)
    setMeta('meta[name="twitter:description"]', 'content', finalDesc)
    setMeta('meta[name="twitter:image"]',       'content', finalImage)
    if (twitterCard) setMeta('meta[name="twitter:card"]', 'content', twitterCard)
    setLink('canonical', finalUrl)

    return () => {
      document.title = DEFAULT_TITLE
      setMeta('meta[name="description"]', 'content', DEFAULT_DESC)
      setMeta('meta[property="og:title"]',       'content', DEFAULT_TITLE)
      setMeta('meta[property="og:description"]', 'content', DEFAULT_DESC)
      setMeta('meta[property="og:url"]',         'content', DEFAULT_URL)
      setMeta('meta[property="og:image"]',       'content', DEFAULT_IMAGE)
      setMeta('meta[name="twitter:title"]',       'content', DEFAULT_TITLE)
      setMeta('meta[name="twitter:description"]', 'content', DEFAULT_DESC)
      setMeta('meta[name="twitter:image"]',       'content', DEFAULT_IMAGE)
      setLink('canonical', DEFAULT_URL)
    }
  }, [title, description, canonical, ogImage, twitterCard])
}
