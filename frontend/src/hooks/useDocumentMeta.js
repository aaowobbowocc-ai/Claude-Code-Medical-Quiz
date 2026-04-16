import { useEffect } from 'react'
import { usePlayerStore } from '../store/gameStore'
import { getExamConfig } from '../config/examRegistry'

const CATEGORY_LABEL = {
  medical:           '醫事人員國考',
  'law-professional': '法律專技國考',
  'civil-service':    '公職國考',
  'common-subjects':  '共同科目題庫',
}

const DEFAULT_META = {
  title: '國考知識王 — 醫事 · 法律 · 公職國考對戰練習平台',
  description: '免費國家考試題庫練習平台，涵蓋醫事 16 類 + 社工 + 律師一試 + 警察特考、公職高普考、法律與共同科目，75,000+ 題考古題。即時對戰、AI 解說、歷屆模擬考、弱點分析，助你高效備考。',
  canonical: 'https://examking.tw/',
  ogUrl: 'https://examking.tw/',
}

function setTag(selector, attr, value) {
  let el = document.head.querySelector(selector)
  if (!el) return
  el.setAttribute(attr, value)
}

function buildExamMeta(cfg) {
  const seo = cfg?.seo || {}
  const categoryLabel = CATEGORY_LABEL[cfg?.category] || ''
  const fullName = seo.fullName || cfg?.name || '國家考試'
  const title = `${fullName}｜國考知識王 — ${categoryLabel || '國考'}線上刷題`
  const base = seo.examDesc || `${fullName}歷屆考古題練習平台，提供模擬考、即時對戰、AI 解說與弱點分析。`
  const description = base.length > 150 ? base.slice(0, 147) + '…' : base
  const canonical = `https://examking.tw/${cfg.id}/`
  return { title, description, canonical, ogUrl: canonical }
}

function applyMeta(meta) {
  document.title = meta.title
  setTag('meta[name="description"]', 'content', meta.description)
  setTag('meta[property="og:title"]', 'content', meta.title)
  setTag('meta[property="og:description"]', 'content', meta.description)
  setTag('meta[property="og:url"]', 'content', meta.ogUrl)
  setTag('meta[name="twitter:title"]', 'content', meta.title)
  setTag('meta[name="twitter:description"]', 'content', meta.description)
  setTag('link[rel="canonical"]', 'href', meta.canonical)
}

/**
 * Syncs <title>, <meta description>, <link canonical>, and og:* tags with
 * the active exam. Googlebot renders JS and picks up these mutations; social
 * scrapers (FB/Threads) won't see them, but the static index.html broadened
 * meta covers the baseline case for shares that don't carry ?exam=.
 */
export function useDocumentMeta() {
  const examId = usePlayerStore(s => s.exam)

  useEffect(() => {
    const cfg = examId ? getExamConfig(examId) : null
    const meta = cfg ? buildExamMeta(cfg) : DEFAULT_META
    applyMeta(meta)
  }, [examId])
}
