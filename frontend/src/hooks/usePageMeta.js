import { useEffect } from 'react'

const DEFAULT_TITLE = '國考知識王 — 醫師國考一階題庫對戰練習'
const DEFAULT_DESC = '免費醫師國考第一階段題庫，涵蓋 110-115 年 2000+ 題，即時對戰、AI 解說、錯題檢討，助你高效備考。'

export function usePageMeta(title, description) {
  useEffect(() => {
    document.title = title ? `${title} | 國考知識王` : DEFAULT_TITLE

    const metaDesc = document.querySelector('meta[name="description"]')
    if (metaDesc) metaDesc.content = description || DEFAULT_DESC

    const ogTitle = document.querySelector('meta[property="og:title"]')
    if (ogTitle) ogTitle.content = title || DEFAULT_TITLE

    const ogDesc = document.querySelector('meta[property="og:description"]')
    if (ogDesc) ogDesc.content = description || DEFAULT_DESC

    return () => {
      document.title = DEFAULT_TITLE
      if (metaDesc) metaDesc.content = DEFAULT_DESC
    }
  }, [title, description])
}
