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
const { fromFile: fromJsxFile, blocksToHtml } = require('./extract-jsx-text.cjs')

const DIST = path.resolve(__dirname, 'dist')
// Prefer in-tree snapshot (works on Vercel where ../backend isn't in build context).
// Fall back to backend/exam-configs for local dev where snapshot may be stale.
const CONFIGS_SNAPSHOT = path.resolve(__dirname, 'src', 'exam-configs-snapshot')
const CONFIGS_BACKEND = path.resolve(__dirname, '..', 'backend', 'exam-configs')
const CONFIGS_DIR = fs.existsSync(CONFIGS_SNAPSHOT) ? CONFIGS_SNAPSHOT : CONFIGS_BACKEND
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
  'state-enterprise': '國營事業招考',
  education: '教師資格考試',
  'common-subjects': '共同科目題庫',
  independent: '駕照筆試題庫',
  'college-entrance': '大學入學考試',
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
    ? `題庫收錄 ${totalQ} 題，年度範圍 100-115 年。即時對戰、AI 解說、歷屆模擬考、弱點分析。`
    : `題庫收錄歷屆考古題，年度範圍 100-115 年。即時對戰、AI 解說、歷屆模擬考、弱點分析。`

  // ─── 2026-05-24 新增深度 SEO 內容（為 AdSense「缺乏內容」拒絕補強）─────
  // articleIntro / subjectDeepDive / studyStrategy / faqs 由 Vertex Gemini 草擬
  // (gen-seo-content.js)，per-exam unique。bake 進 prerender HTML 讓 Googlebot
  // 不用跑 JS 就讀得到。同時 ExamArticle 元件 runtime 也會 render 同份內容。
  const articleIntroHtml = seo.articleIntro
    ? `<h2 style="font-size:1.2rem;margin-top:1.5rem">${esc(seo.shortName || cfg.short || cfg.name)}深度介紹</h2>\n${seo.articleIntro.split(/\n\n+/).map(p => `        <p>${esc(p.trim())}</p>`).join('\n')}`
    : ''
  const subjectDeepHtml = Array.isArray(seo.subjectDeepDive) && seo.subjectDeepDive.length
    ? `<h2 style="font-size:1.2rem;margin-top:1.5rem">各科考點深度解析</h2>\n${seo.subjectDeepDive.map(s => `        <p><strong>${esc(s.name)}</strong>：${esc(s.desc)}</p>`).join('\n')}`
    : ''
  const studyStrategyHtml = seo.studyStrategy
    ? `<h2 style="font-size:1.2rem;margin-top:1.5rem">備考策略與時程規劃</h2>\n${seo.studyStrategy.split(/\n\n+/).map(p => `        <p>${esc(p.trim()).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')}</p>`).join('\n')}`
    : ''
  const faqsHtml = Array.isArray(seo.faqs) && seo.faqs.length
    ? `<h2 style="font-size:1.2rem;margin-top:1.5rem">常見問答</h2>\n${seo.faqs.map(f => `        <p><strong>Q：${esc(f.q)}</strong></p>\n        <p>A：${esc(f.a)}</p>`).join('\n')}`
    : ''
  // FAQPage JSON-LD for Google rich snippet
  const faqLdJson = Array.isArray(seo.faqs) && seo.faqs.length
    ? `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: seo.faqs.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) })}</script>`
    : ''

  // Build exam-specific crawlable content block (shared by #root and <noscript>).
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
        ${articleIntroHtml}
        ${subjectDeepHtml}
        ${studyStrategyHtml}
        ${faqsHtml}
        ${faqLdJson}
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

function buildGuideShell(tpl, guide) {
  const title = `${guide.title}｜國考知識王`
  const description = trim(guide.description || '', 150)
  const canonical = `https://examking.tw/guides/${guide.slug}/`
  const keywords = guide.keywords || '國考,備考攻略,國考知識王'
  let html = tpl

  html = replaceTag(html, /<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
  html = replaceTag(html, /<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${esc(description)}" />`)
  html = replaceTag(html, /<meta name="keywords" content="[^"]*" \/>/, `<meta name="keywords" content="${esc(keywords)}" />`)
  html = replaceTag(html, /<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${canonical}" />`)
  html = replaceTag(html, /<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${esc(title)}" />`)
  html = replaceTag(html, /<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${esc(description)}" />`)
  html = replaceTag(html, /<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${canonical}" />`)
  html = replaceTag(html, /<meta name="twitter:title" content="[^"]*" \/>/, `<meta name="twitter:title" content="${esc(title)}" />`)
  html = replaceTag(html, /<meta name="twitter:description" content="[^"]*" \/>/, `<meta name="twitter:description" content="${esc(description)}" />`)

  const related = (guide.related || [])
    .map(r => `        <li><a href="${esc(r.slug)}">${esc(r.label)}</a></li>`)
    .join('\n')

  const staticBody = `
      <article style="max-width:720px;margin:40px auto;padding:20px;font-family:'Noto Sans TC',sans-serif;color:#333;line-height:1.8">
        <nav style="font-size:0.85rem;color:#666;margin-bottom:0.5rem">
          <a href="/guides">備考攻略</a> › <span>${esc(guide.title)}</span>
        </nav>
        <h1 style="font-size:1.6rem;color:#1A6B9A">${esc(guide.title)}</h1>
        <p style="font-size:0.8rem;color:#999">${esc(guide.date || '')}</p>
        <div>${guide.contentHtml || ''}</div>
        ${related ? `<h2 style="font-size:1.1rem;margin-top:2rem">相關資源</h2>\n        <ul>\n${related}\n        </ul>` : ''}
        <nav style="margin-top:2rem;font-size:0.9rem;color:#666">
          <a href="/guides">← 返回攻略列表</a> | <a href="/">首頁</a>
        </nav>
      </article>`

  html = html.replace(
    /(<div id="root">)[\s\S]*?<!-- \/static-seo -->/,
    `$1${staticBody}\n      <!-- /static-seo -->`
  )
  html = html.replace(/<noscript>\s*<div style="max-width:6[\s\S]*?<\/noscript>/,
    `<noscript>${staticBody}\n      <p>請啟用 JavaScript 以使用完整功能。</p>\n    </noscript>`)
  return html
}

function buildGuideIndexShell(tpl, guides) {
  const title = '備考攻略｜國考知識王'
  const description = '國考備考攻略與學習心法：醫師、藥師、護理師、醫檢師等各國考準備指南，以及 AI 刷題、間隔重複等學習法實戰。'
  const canonical = 'https://examking.tw/guides/'
  let html = tpl
  html = replaceTag(html, /<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
  html = replaceTag(html, /<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${esc(description)}" />`)
  html = replaceTag(html, /<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${canonical}" />`)
  html = replaceTag(html, /<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${esc(title)}" />`)
  html = replaceTag(html, /<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${esc(description)}" />`)
  html = replaceTag(html, /<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${canonical}" />`)

  const list = guides.map(g =>
    `        <li style="margin-bottom:1rem"><a href="/guides/${esc(g.slug)}" style="font-weight:bold;color:#1A6B9A">${esc(g.title)}</a><br><span style="color:#666;font-size:0.9rem">${esc(g.description)}</span></li>`
  ).join('\n')

  const staticBody = `
      <div style="max-width:720px;margin:40px auto;padding:20px;font-family:'Noto Sans TC',sans-serif;color:#333;line-height:1.7">
        <h1 style="font-size:1.6rem;color:#1A6B9A">備考攻略</h1>
        <p>依考試類別 & 學習方法整理的長文指南。</p>
        <ul>
${list}
        </ul>
        <nav style="margin-top:2rem;font-size:0.9rem;color:#666"><a href="/">首頁</a> | <a href="/changelog">更新公告</a></nav>
      </div>`
  html = html.replace(
    /(<div id="root">)[\s\S]*?<!-- \/static-seo -->/,
    `$1${staticBody}\n      <!-- /static-seo -->`
  )
  html = html.replace(/<noscript>\s*<div style="max-width:6[\s\S]*?<\/noscript>/,
    `<noscript>${staticBody}\n      <p>請啟用 JavaScript 以使用完整功能。</p>\n    </noscript>`)
  return html
}

/*
 * 靜態頁（隱私權政策／服務條款／關於我們）。
 *
 * 2026-10-26 以前這三頁沒有 prerender，走 vercel.json 的 /(.*)→/index.html，
 * 所以爬蟲抓 /privacy 拿到的是**首頁的 HTML**，連 canonical 都指向首頁
 * （實測 /、/practice、/privacy、/coverage 的 md5 一模一樣）。
 * 結果是法律頁面對搜尋引擎等於不存在 —— 而 AdSense 明文要求看得到隱私權政策。
 *
 * 內容與 title/description 都從 .jsx 原始碼抽（extract-jsx-text.cjs），
 * 不另外維護一份靜態副本；否則改了頁面而忘了改這裡，爬蟲會看到過期的政策
 * （[[feedback_legal_pages]]）。抽不到就跳過該頁並印警告，不要生出半截頁面。
 */
const STATIC_PAGES = [
  { route: 'privacy', src: 'Privacy.jsx', keywords: '隱私權政策,Cookie,Google 廣告,個人資料,國考知識王' },
  { route: 'tos', src: 'Terms.jsx', keywords: '服務條款,使用規範,免責聲明,題庫來源,國考知識王' },
  { route: 'contact', src: 'Contact.jsx', keywords: '關於我們,聯絡方式,國考題庫,國考知識王' },
]

/*
 * 功能頁。這些頁的 JSX 內容是互動 UI，抽不出有意義的散文，
 * 所以**不**走 extract-jsx-text，改用這裡手寫的一兩句說明。
 *
 * 重點不在「生出內容」，而在**停止宣告 canonical 指向首頁**：
 * 2026-10-27 之前這 12 條全部送出與首頁 byte 相同的 HTML，
 * canonical 都寫 https://examking.tw/，等於 Google 把它們併成一頁。
 *
 * personal: true 的是個人化頁面（要登入才有內容），加 noindex 並且
 * 從 sitemap 移除 —— 它們本來就不該被索引。
 */
const APP_ROUTES = [
  { route: 'browse', title: '題庫瀏覽',
    desc: '依考試、年度與科目瀏覽歷屆試題，可直接翻看題目與官方答案。',
    links: [['/practice', '練習模式'], ['/mock-exam', '歷屆模擬考'], ['/coverage', '題庫覆蓋率']] },
  { route: 'practice', title: '練習模式',
    desc: '選定考試與科目後連續作答，答錯的題目自動進入錯題本，可開啟 AI 解說逐題理解。',
    links: [['/browse', '題庫瀏覽'], ['/mock-exam', '歷屆模擬考']] },
  { route: 'mock-exam', title: '歷屆模擬考',
    desc: '依各考試實際的卷別、題數與作答時限應考，並依官方及格標準計分。',
    links: [['/practice', '練習模式'], ['/browse', '題庫瀏覽']] },
  { route: 'map', title: '學習地圖',
    desc: '以科目為單位檢視各考試的作答進度與熟練度分布。',
    links: [['/practice', '練習模式']] },
  { route: 'leaderboard', title: '排行榜',
    desc: '每週重置的答題排行，依名次分段顯示。',
    links: [['/board', '留言板']] },
  { route: 'board', title: '留言板',
    desc: '使用者交流與回報題目問題的公開留言板。',
    links: [['/contact', '關於我們']] },
  { route: 'changelog', title: '更新公告',
    desc: '題庫更新、功能調整與使用者回饋處理紀錄。',
    links: [['/coverage', '題庫覆蓋率'], ['/contact', '關於我們']] },
  { route: 'coverage', title: '題庫覆蓋率',
    desc: '各考試、各年度已收錄的題數與缺題狀況。',
    links: [['/browse', '題庫瀏覽'], ['/changelog', '更新公告']] },

  { route: 'notes', title: '筆記', personal: true, desc: '個人筆記，需登入後才有內容。' },
  { route: 'history', title: '作答紀錄', personal: true, desc: '個人作答紀錄，需登入後才有內容。' },
  { route: 'favorites', title: '收藏題目', personal: true, desc: '個人收藏的題目，需登入後才有內容。' },
  { route: 'weakness', title: '弱點分析', personal: true, desc: '依個人作答紀錄產生的弱點分析，需登入後才有內容。' },
]

function buildAppRouteShell(tpl, r) {
  const title = `${r.title}｜國考知識王`
  const description = trim(r.desc, 150)
  const canonical = `https://examking.tw/${r.route}`
  let html = tpl

  html = replaceTag(html, /<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
  html = replaceTag(html, /<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${esc(description)}" />`)
  html = replaceTag(html, /<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${canonical}" />`)
  html = replaceTag(html, /<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${esc(title)}" />`)
  html = replaceTag(html, /<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${esc(description)}" />`)
  html = replaceTag(html, /<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${canonical}" />`)
  html = replaceTag(html, /<meta name="twitter:title" content="[^"]*" \/>/, `<meta name="twitter:title" content="${esc(title)}" />`)
  html = replaceTag(html, /<meta name="twitter:description" content="[^"]*" \/>/, `<meta name="twitter:description" content="${esc(description)}" />`)

  // 個人化頁面明確告訴爬蟲不要索引（它們沒登入就沒有內容）
  if (r.personal) {
    html = html.replace(/<link rel="canonical"/, '<meta name="robots" content="noindex,follow" />\n    <link rel="canonical"')
  }

  const linkHtml = (r.links || []).map(([href, label]) => `          <li><a href="${esc(href)}">${esc(label)}</a></li>`).join('\n')
  const staticBody = `
      <div style="max-width:720px;margin:40px auto;padding:20px;font-family:'Noto Sans TC',sans-serif;color:#333;line-height:1.7">
        <h1 style="font-size:1.6rem;color:#1A6B9A">${esc(r.title)}</h1>
        <p>${esc(r.desc)}</p>
${linkHtml ? `        <h2 style="font-size:1.2rem;margin-top:1.5rem">相關頁面</h2>\n        <ul>\n${linkHtml}\n        </ul>` : ''}
        <nav style="margin-top:1.5rem;font-size:0.9rem;color:#666">
          <a href="/">首頁</a> |
          <a href="/privacy">隱私權政策</a> |
          <a href="/tos">服務條款</a> |
          <a href="/contact">關於我們</a>
        </nav>
      </div>`

  html = html.replace(
    /(<div id="root">)[\s\S]*?<!-- \/static-seo -->/,
    `$1${staticBody}\n      <!-- /static-seo -->`
  )
  html = html.replace(/<noscript>\s*<div style="max-width:6[\s\S]*?<\/noscript>/,
    `<noscript>${staticBody}\n      <p>請啟用 JavaScript 以使用完整功能。</p>\n    </noscript>`)
  return html
}

function buildStaticPageShell(tpl, page, blocks) {
  const meta = blocks.meta || {}
  const title = `${meta.title || page.route}｜國考知識王`
  const description = trim(meta.description || '', 150)
  // ⚠️ 不加結尾斜線 —— generate-sitemap.cjs 的 STATIC_ROUTES 寫的是
  //    '/privacy'、'/tos'、'/contact'（考試頁與 guides 才是帶斜線的）。
  //    canonical 跟 sitemap 不一致會讓 Google 兩邊互相打架。
  const canonical = `https://examking.tw/${page.route}`
  let html = tpl

  html = replaceTag(html, /<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
  html = replaceTag(html, /<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${esc(description)}" />`)
  html = replaceTag(html, /<meta name="keywords" content="[^"]*" \/>/, `<meta name="keywords" content="${esc(page.keywords)}" />`)
  html = replaceTag(html, /<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${canonical}" />`)
  html = replaceTag(html, /<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${esc(title)}" />`)
  html = replaceTag(html, /<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${esc(description)}" />`)
  html = replaceTag(html, /<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${canonical}" />`)
  html = replaceTag(html, /<meta name="twitter:title" content="[^"]*" \/>/, `<meta name="twitter:title" content="${esc(title)}" />`)
  html = replaceTag(html, /<meta name="twitter:description" content="[^"]*" \/>/, `<meta name="twitter:description" content="${esc(description)}" />`)

  const staticBody = `
      <div style="max-width:720px;margin:40px auto;padding:20px;font-family:'Noto Sans TC',sans-serif;color:#333;line-height:1.8">
${blocksToHtml(blocks)}
        <nav style="margin-top:2rem;font-size:0.9rem;color:#666">
          <a href="/">首頁</a> |
          <a href="/privacy">隱私權政策</a> |
          <a href="/tos">服務條款</a> |
          <a href="/contact">關於我們</a>
        </nav>
      </div>`

  html = html.replace(
    /(<div id="root">)[\s\S]*?<!-- \/static-seo -->/,
    `$1${staticBody}\n      <!-- /static-seo -->`
  )
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

  // Guides: prerender /guides/ + each /guides/:slug/
  const guidesFile = path.resolve(__dirname, 'src', 'guides.json')
  if (fs.existsSync(guidesFile)) {
    try {
      const { guides } = JSON.parse(fs.readFileSync(guidesFile, 'utf8'))
      if (Array.isArray(guides) && guides.length) {
        const guidesDir = path.join(DIST, 'guides')
        fs.mkdirSync(guidesDir, { recursive: true })
        fs.writeFileSync(path.join(guidesDir, 'index.html'), buildGuideIndexShell(tpl, guides))
        for (const g of guides) {
          if (!g.slug) continue
          const outDir = path.join(guidesDir, g.slug)
          fs.mkdirSync(outDir, { recursive: true })
          fs.writeFileSync(path.join(outDir, 'index.html'), buildGuideShell(tpl, g))
        }
        console.log(`[generate-shells] wrote 1 guides index + ${guides.length} guide pages → dist/guides/`)
      }
    } catch (e) {
      console.warn(`[generate-shells] guides skip: ${e.message}`)
    }
  }

  // 靜態頁：/privacy、/tos、/contact
  let staticCount = 0
  for (const page of STATIC_PAGES) {
    const srcPath = path.resolve(__dirname, 'src', 'pages', page.src)
    const blocks = fromJsxFile(srcPath)
    if (!blocks) {
      console.warn(`[generate-shells] warn: 抽不到 ${page.src} 的內容，/${page.route} 不產生靜態頁`)
      continue
    }
    const outDir = path.join(DIST, page.route)
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'index.html'), buildStaticPageShell(tpl, page, blocks))
    staticCount++
  }
  console.log(`[generate-shells] wrote ${staticCount} static pages → dist/{privacy,tos,contact}/index.html`)

  // 功能頁：不是為了生內容，是為了讓它們不要再宣告 canonical 指向首頁
  let appCount = 0, noindexCount = 0
  for (const r of APP_ROUTES) {
    const outDir = path.join(DIST, r.route)
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'index.html'), buildAppRouteShell(tpl, r))
    appCount++
    if (r.personal) noindexCount++
  }
  console.log(`[generate-shells] wrote ${appCount} app routes (${noindexCount} noindex) → dist/<route>/index.html`)
}

main()
