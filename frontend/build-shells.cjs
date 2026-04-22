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
const INTROS_FILE = path.resolve(__dirname, 'src', 'seo-intros.json')

let INTROS = {}
try {
  if (fs.existsSync(INTROS_FILE)) {
    INTROS = JSON.parse(fs.readFileSync(INTROS_FILE, 'utf8'))
    console.log(`[generate-shells] loaded ${Object.keys(INTROS).length} long-form intros from src/seo-intros.json`)
  } else {
    console.warn(`[generate-shells] warn: ${INTROS_FILE} not found — will fall back to examDesc for intro`)
  }
} catch (e) {
  console.warn(`[generate-shells] warn: cannot parse seo-intros.json (${e.message}) — falling back`)
}

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

  // Long-form intro (400字 Gemini-generated) with fallback to examDesc + paperDesc
  const longIntro = (INTROS[cfg.id] && String(INTROS[cfg.id]).trim())
    || [descBase, seo.paperDesc].filter(Boolean).join('')

  // Paper/subject list from papers[].subject (falls back to seo.subjects split)
  const paperSubjects = Array.isArray(cfg.papers) && cfg.papers.length
    ? cfg.papers.map(p => p.subject || p.name).filter(Boolean)
    : subjectList
  const paperListHtml = paperSubjects.length
    ? paperSubjects.map(s => `          <li>${esc(s)}</li>`).join('\n')
    : '          <li>詳見考選部公告</li>'

  const totalQ = cfg.totalQ || (seo && seo.totalQ) || ''
  const statsSentence = totalQ
    ? `題庫收錄 ${totalQ} 題，年度範圍 106-115 年。即時對戰、AI 解說、歷屆模擬考、弱點分析。`
    : `題庫收錄歷屆考古題，年度範圍 106-115 年。即時對戰、AI 解說、歷屆模擬考、弱點分析。`

  // Build exam-specific crawlable content block (shared by #root and <noscript>).
  // Structure per SEO spec: H1 → 400字 intro → 考試科目 → 統計 → 相關資源.
  const staticBody = `
      <div style="max-width:720px;margin:40px auto;padding:20px;font-family:'Noto Sans TC',sans-serif;color:#333;line-height:1.7">
        <h1 style="font-size:1.6rem;color:#1A6B9A">${esc(fullName)} 線上題庫與模擬考</h1>
        <p>${esc(longIntro)}</p>
        <h2 style="font-size:1.2rem;margin-top:1.5rem">考試科目</h2>
        <ul>
${paperListHtml}
        </ul>
        <h2 style="font-size:1.2rem;margin-top:1.5rem">統計</h2>
        <p>${esc(statsSentence)}</p>
        <h2 style="font-size:1.2rem;margin-top:1.5rem">相關資源</h2>
        <ul>
          <li><a href="/practice">練習模式</a></li>
          <li><a href="/mock-exam">歷屆模擬考</a></li>
          <li><a href="/browse">題庫瀏覽</a></li>
        </ul>
        <nav style="margin-top:1.5rem;font-size:0.9rem;color:#666">
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
