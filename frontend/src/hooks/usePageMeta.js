import { useEffect } from 'react'

const DEFAULT_TITLE = '國考知識王 — 最專業的醫藥護國考對戰練習平台'
const DEFAULT_DESC = '免費醫事國考題庫，涵蓋醫師、牙醫、藥師、護理師等 11 類考試，18,000+ 題。即時對戰、AI 解說、歷屆模擬考、弱點分析，助你高效備考！'

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
