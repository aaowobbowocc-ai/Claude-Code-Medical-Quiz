#!/usr/bin/env node
/*
 * generate-shells.js — post-build static SEO prerender
 *
 * Reads dist/index.html (the Vite build output), then for each exam-config
 * writes dist/<examId>/index.html with exam-specific <title>, meta, og:*,
 * canonical, and a <noscript> body. Googlebot indexes these without needing
 * to run JS, which unblocks the "已找到 - 目前尚未建立索引" state on
 * query-param URLs.
 *
 * URLs become examking.tw/doctor1/, examking.tw/civil-senior-general/, …
 * React Router's /:examSlug route reads the path and sets active exam state.
 */
const fs = require('fs')
const path = require('path')

const DIST = path.resolve(__dirname, 'dist')
const CONFIGS_DIR = path.resolve(__dirname, '..', 'backend', 'exam-configs')
const TEMPLATE = path.join(DIST, 'index.html')

const CATEGORY_LABEL = {
  medical: '醫事人員國考',
  'law-professional': '法律專技國考',
  'civil-service': '公職國考',
  'common-subjects': '共同科目題庫',
  independent: '駕照筆試題庫',
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function trim(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

function replaceTag(html, re, replacement) {
  if (!re.test(html)) {
    console.warn(`[generate-shells] warn: template tag not found for ${re}`)
  }
  return html.replace(re, replacement)
}

function buildShell(tpl, cfg) {
  const seo = cfg.seo || {}
  const fullName = seo.fullName || cfg.name || cfg.id
  const categoryLabel = CATEGORY_LABEL[cfg.category] || '國考'
  const title = `${fullName}｜國考知識王 — ${categoryLabel}線上刷題`
  const descBase = seo.examDesc
    || `${fullName}歷屆考古題練習平台，提供模擬考、即時對戰、AI 解說與弱點分析。`
  const description = trim(descBase, 150)
  const canonical = `https://examking.tw/${cfg.id}/`
  const subjectList = seo.subjects
    ? seo.subjects.split(/[、,，]/).map(x => x.trim()).filter(Boolean).slice(0, 10)
    : []
  const keywords = [
    '國考知識王',
    fullName,
    categoryLabel,
    '國考題庫',
    '考古題',
    '模擬考',
    'AI 解說',
    ...subjectList,
  ].filter(Boolean).join(',')

  let html = tpl

  html = replaceTag(html, /<title>[^<]*<\/title>/,
    `<title>${esc(title)}</title>`)

  html = replaceTag(html, /<meta name="description" content="[^"]*" \/>/,
    `<meta name="description" content="${esc(description)}" />`)

  html = replaceTag(html, /<meta name="keywords" content="[^"]*" \/>/,
    `<meta name="keywords" content="${esc(keywords)}" />`)

  html = replaceTag(html, /<link rel="canonical" href="[^"]*" \/>/,
    `<link rel="canonical" href="${canonical}" />`)

  html = replaceTag(html, /<meta property="og:title" content="[^"]*" \/>/,
    `<meta property="og:title" content="${esc(title)}" />`)

  html = replaceTag(html, /<meta property="og:description" content="[^"]*" \/>/,
    `<meta property="og:description" content="${esc(description)}" />`)

  html = replaceTag(html, /<meta property="og:url" content="[^"]*" \/>/,
    `<meta property="og:url" content="${canonical}" />`)

  html = replaceTag(html, /<meta name="twitter:title" content="[^"]*" \/>/,
    `<meta name="twitter:title" content="${esc(title)}" />`)

  html = replaceTag(html, /<meta name="twitter:description" content="[^"]*" \/>/,
    `<meta name="twitter:description" content="${esc(description)}" />`)

  // Build exam-specific crawlable content block (shared by #root and <noscript>)
  const staticBody = `
      <div style="max-width:640px;margin:40px auto;padding:20px;font-family:'Noto Sans TC',sans-serif;color:#333;line-height:1.7">
        <h1 style="font-size:1.5rem;color:#1A6B9A">${esc(fullName)} — 國考知識王</h1>
        <p>${esc(descBase)}</p>
${seo.paperDesc ? `        <h2 style="font-size:1.2rem;margin-top:1.5rem">考試結構</h2>\n        <p>${esc(seo.paperDesc)}</p>\n` : ''}${seo.subjects ? `        <h2 style="font-size:1.2rem;margin-top:1.5rem">考試科目</h2>\n        <p>${esc(seo.subjects)}</p>\n` : ''}        <h2 style="font-size:1.2rem;margin-top:1.5rem">平台功能</h2>
        <ul>
          <li>歷屆考古題練習 — 依科目、年度篩選</li>
          <li>即時對戰 — 與其他考生即時 PK</li>
          <li>歷屆模擬考 — 模擬真實國考限時作答</li>
          <li>AI 智慧解說 — 每題提供詳細解析</li>
          <li>弱點分析 — 追蹤正確率找出弱科</li>
          <li>精華筆記、留言板、排行榜</li>
        </ul>
        <p>完全免費，無需註冊。</p>
        <nav>
          <a href="/">首頁</a> |
          <a href="/privacy">隱私權政策</a> |
          <a href="/tos">服務條款</a> |
          <a href="/contact">關於我們</a>
        </nav>
      </div>`

  // Inject visible static content inside <div id="root"> so Googlebot reads it
  // before JS mounts. React.createRoot().render() replaces this on hydration.
  // The <!-- /static-seo --> marker delimits the replaceable block.
  html = html.replace(
    /(<div id="root">)[\s\S]*?<!-- \/static-seo -->/,
    `$1${staticBody}\n      <!-- /static-seo -->`
  )

  // Also update the main content <noscript> (the one inside <body>, not the font one in <head>).
  // Target it by matching the noscript that contains the platform description.
  html = html.replace(/<noscript>\s*<div style="max-width:6[\s\S]*?<\/noscript>/,
    `<noscript>${staticBody}\n      <p>請啟用 JavaScript 以使用完整功能。</p>\n    </noscript>`)

  return html
}

function main() {
  if (!fs.existsSync(TEMPLATE)) {
    console.error(`[generate-shells] ${TEMPLATE} not found — run vite build first`)
    process.exit(1)
  }
  if (!fs.existsSync(CONFIGS_DIR)) {
    console.error(`[generate-shells] ${CONFIGS_DIR} not found`)
    process.exit(1)
  }

  const tpl = fs.readFileSync(TEMPLATE, 'utf8')
  const configs = fs.readdirSync(CONFIGS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, f), 'utf8'))
      } catch (e) {
        console.warn(`[generate-shells] skip ${f}: ${e.message}`)
        return null
      }
    })
    .filter(Boolean)

  let count = 0
  for (const cfg of configs) {
    if (!cfg.id) continue
    const html = buildShell(tpl, cfg)
    const outDir = path.join(DIST, cfg.id)
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'index.html'), html)
    count++
  }
  console.log(`[generate-shells] wrote ${count} exam shells → dist/<id>/index.html`)
}

main()
