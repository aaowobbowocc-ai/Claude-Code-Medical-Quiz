/*
 * extract-jsx-text.cjs — 從頁面元件的 JSX 原始碼抽出可讀文字。
 *
 * 給 build-shells.cjs 產生 /privacy、/tos、/contact 的靜態 HTML 用。
 *
 * 為什麼不把文字複製一份到 build-shells.cjs：那會變成兩份來源，
 * 改了 Privacy.jsx 而忘了改靜態版，爬蟲就會看到過期的隱私權政策
 * （[[feedback_legal_pages]] 要求功能或資料蒐集變更時同步更新法律頁）。
 * 這支直接讀 .jsx，單一來源。
 *
 * 做法刻意保守：只認得文字節點與 h1/h2/p/li/a 的結構，
 * 遇到 JSX 運算式 {…} 一律丟掉（那些是 className、handler、變數插值）。
 * 抽不出東西時回傳 null，呼叫端要自己決定怎麼辦，不要生出半截頁面。
 */
const fs = require('fs')

/** JSX 屬性裡的 {…} 會有巢狀大括號，要配對著吃掉。 */
function stripBraces(s) {
  let out = '', depth = 0
  for (const ch of s) {
    if (ch === '{') { depth++; continue }
    if (ch === '}') { if (depth > 0) depth--; continue }
    if (!depth) out += ch
  }
  return out
}

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }
const decode = s => s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, m => ENT[m] || m)

/**
 * 頁面裡會用 {`涵蓋 ${SITE.exams} 種國考`} 這種模板字串帶入全站數字。
 * stripBraces() 會把整段 {…} 丟掉，所以要先在這裡展開，
 * 否則 prerender 出來的 /privacy、/contact 會少掉那幾句。
 *
 * 只支援 ${識別字.屬性}，值從 site-stats.json 來。
 * 碰到解不掉的運算式就把**整段**丟掉（維持原本保守的行為：
 * 寧可少一句，也不要把 `${...}` 原封不動印給使用者看）。
 */
let SITE = {}
try { SITE = require('./src/site-stats.json') } catch { /* 還沒產生就當沒有 */ }
const VARS = { SITE }

function resolveTemplates(src) {
  return src.replace(/\{\s*`([^`]*)`\s*\}/g, (_, body) => {
    let bad = false
    const out = body.replace(/\$\{\s*([A-Za-z_$][\w$]*)\.([\w$]+)\s*\}/g, (__, obj, key) => {
      const v = VARS[obj] && VARS[obj][key]
      if (v === undefined) { bad = true; return '' }
      return String(v)
    })
    return (bad || out.includes('${')) ? '' : out
  })
}

/**
 * 回傳 [{ tag: 'h1'|'h2'|'p'|'li', text }]，抽不到回 null。
 */
function extractBlocks(src) {
  // 只看 return (...) 之後的 JSX，前面的 import / hook 不要
  const i = src.indexOf('return (')
  let body = i >= 0 ? src.slice(i + 'return ('.length) : src

  // 註解先拿掉，接著展開 {`…${SITE.x}…`} 模板，最後才把其餘 JSX 運算式
  // （className、onClick、變數）整段丟掉 —— 順序不能反，反了模板也會被吃掉。
  body = body.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
  body = resolveTemplates(body)
  body = stripBraces(body)

  const blocks = []
  const re = /<(h1|h2|h3|p|li)\b[^>]*>([\s\S]*?)<\/\1>/g
  let m
  while ((m = re.exec(body)) !== null) {
    // 內層還可能有 <strong>、<a>，把標籤去掉留文字
    let t = m[2].replace(/<[^>]*>/g, '')
    t = decode(t).replace(/\s+/g, ' ').trim()
    if (!t) continue
    // 純標點或只剩箭頭之類的裝飾不要
    if (!/[一-鿿A-Za-z0-9]/.test(t)) continue
    blocks.push({ tag: m[1] === 'h3' ? 'h2' : m[1], text: t })
  }
  return blocks.length ? blocks : null
}

/** 轉成要塞進 prerender HTML 的片段。 */
function blocksToHtml(blocks) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const out = []
  let inList = false
  for (const b of blocks) {
    if (b.tag === 'li') {
      if (!inList) { out.push('        <ul>'); inList = true }
      out.push(`          <li>${esc(b.text)}</li>`)
      continue
    }
    if (inList) { out.push('        </ul>'); inList = false }
    if (b.tag === 'h1') out.push(`        <h1 style="font-size:1.6rem;color:#1A6B9A">${esc(b.text)}</h1>`)
    else if (b.tag === 'h2') out.push(`        <h2 style="font-size:1.2rem;margin-top:1.5rem">${esc(b.text)}</h2>`)
    else out.push(`        <p>${esc(b.text)}</p>`)
  }
  if (inList) out.push('        </ul>')
  return out.join('\n')
}

/**
 * 抓 usePageMeta('標題', '描述') 的兩個字串，讓 prerender 的 <title> 與
 * meta description 跟 runtime 同一個來源，不會改了一邊忘了另一邊。
 * 抓不到回 null。
 */
function extractPageMeta(src) {
  const m = src.match(/usePageMeta\(\s*(['"`])([\s\S]*?)\1\s*,\s*(['"`])([\s\S]*?)\3\s*\)/)
  if (!m) return null
  // 第二個參數可能是 `…${SITE.questionsRounded}…` 的模板字串
  const unwrap = (raw, quote) => quote !== '`' ? raw : (resolveTemplates('{`' + raw + '`}') || null)
  const title = unwrap(m[2], m[1])
  const description = unwrap(m[4], m[3])
  return (title && description) ? { title, description } : null
}

function fromFile(p) {
  if (!fs.existsSync(p)) return null
  const src = fs.readFileSync(p, 'utf8')
  const blocks = extractBlocks(src)
  if (!blocks) return null
  blocks.meta = extractPageMeta(src)
  return blocks
}

module.exports = { extractBlocks, extractPageMeta, blocksToHtml, fromFile }

// 直接執行時當作檢查工具：node extract-jsx-text.cjs src/pages/Privacy.jsx
if (require.main === module) {
  const p = process.argv[2]
  const b = fromFile(p)
  if (!b) { console.error('抽不到內容:', p); process.exit(1) }
  console.log(`${p} → ${b.length} 個區塊，共 ${b.reduce((s, x) => s + x.text.length, 0)} 字\n`)
  for (const x of b) console.log(`[${x.tag}] ${x.text.slice(0, 110)}`)
}
