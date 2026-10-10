/**
 * 中華郵政（郵局招考）專業職(二) 試題解答 PDF 解析器 — 來源：三民輔考
 *
 * 版面特性（與台電 / 考選部都不同）：
 *  - 答案內嵌：每題前綴【X】，X 為答案字母對應的選項序（1-4），如「【4】1.題目…」，
 *    爭議題為「【1,2,3,4】」「【1或2】」。
 *  - 選項「沒有 (A)(B)(C)(D) 標記」：靠雙欄版面排列，每個選項通常是獨立 text line，
 *    各有自己的 x 座標；偶爾兩個選項被 mupdf 併進同一行。
 *  - 整頁左右兩大欄，題序為「左欄由上到下 → 右欄由上到下」。
 *  - 部分卷（郵政三法）文字層較差、選項前有項目符號（PUA / U+FFFD）。
 *
 * 解析策略：用 mupdf bbox 座標還原版面 —— 找【X】題號錨點、依大欄切題塊、
 * 用 y 分行 x 分欄重組 4 個選項。
 */

const PUA_RE = /[-�]/g
const BULLETS = '\\s　•·‧∙●◦○▲△■□◆◇※☆★'
const HEAD_BULLET_RE = new RegExp(`^[${BULLETS}]+`)
const TAIL_BULLET_RE = new RegExp(`[${BULLETS}]+$`)

const stripPUA = s => String(s || '').replace(PUA_RE, '')

// 選項結尾不該是這些字 —— 切在半路的簽章（「各類郵件得交該管理服務人員或郵件收，」）
const CUT_RE = /[、，,（(]$/

// 清頭尾項目符號 / PUA / 多餘空白。題幹尾與選項頭常黏到隔壁的 bullet。
function clean(s) {
  return stripPUA(s)
    .replace(HEAD_BULLET_RE, '')
    .replace(TAIL_BULLET_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// 【X】題號. ：擷取答案與題號。X 可為「4」「1,2,3,4」「1或2」「本題送分」
const ANCHOR_RE = /^【\s*([^】]{1,16})\s*】\s*(\d{1,3})\s*[.．、]?\s*(.*)$/

// 解讀【】內容 → { answer, disputed }；answer 為 'A'-'D'
function interpretMarker(raw) {
  const nums = (raw.match(/[1-4]/g) || []).map(Number)
  const hasGive = /送分|給分|一律|皆可/.test(raw)
  if (nums.length === 0) return null                       // 非答案標記
  const toLetter = n => 'ABCD'[n - 1]
  if (nums.length > 1 || hasGive || /[或、，,]/.test(raw)) {
    return { answer: toLetter(nums[0]), disputed: true }   // 多答案 / 送分 → 爭議題
  }
  return { answer: toLetter(nums[0]), disputed: false }
}

// mupdf：取每頁的 text lines（含座標）
async function loadPages(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const pages = []
  for (let i = 0; i < doc.countPages(); i++) {
    const parsed = JSON.parse(doc.loadPage(i).toStructuredText('preserve-images').asJSON())
    const lines = []
    for (const b of parsed.blocks) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const t = stripPUA(ln.text || '').replace(/\s+$/, '')
        if (!t.trim()) continue
        lines.push({
          y: Math.round(ln.bbox.y), x: Math.round(ln.bbox.x),
          w: Math.round(ln.bbox.w), h: Math.round(ln.bbox.h), text: t,
        })
      }
    }
    lines.sort((a, b) => a.y - b.y || a.x - b.x)
    pages.push(lines)
  }
  return pages
}

// 把 lines 依 y 群成 rows，每 row 的 parts 依 x 排序
function groupRows(lines, tol = 6) {
  const rows = []
  for (const ln of [...lines].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const last = rows[rows.length - 1]
    if (last && Math.abs(last.y - ln.y) <= tol) { last.parts.push(ln); last.y = (last.y + ln.y) / 2 }
    else rows.push({ y: ln.y, parts: [ln] })
  }
  for (const r of rows) r.parts.sort((a, b) => a.x - b.x)
  return rows
}

// row 是否像「選項列」：≥2 part 且 part 間有明顯 x 間距
function isOptionRow(row) {
  if (row.parts.length < 2) return false
  const xs = row.parts.map(p => p.x).sort((a, b) => a - b)
  for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > 45) return true
  return false
}

// 把一個 part 依欄位 x 切成兩段（給「兩選項併一行」用）
function splitByColumn(part, colXs) {
  const next = colXs.find(cx => cx > part.x + 40)
  if (!next || !part.w) return null
  const span = next - part.x
  if (part.w <= span + 8) return null
  const text = stripPUA(part.text)
  const weight = c => /[一-鿿　-〿＀-￯]/.test(c) ? 1 : 0.55
  const total = [...text].reduce((s, c) => s + weight(c), 0)
  if (total <= 0) return null
  const pxPer = part.w / total
  let cum = 0, idx = -1
  for (let i = 0; i < text.length; i++) {
    cum += weight(text[i]) * pxPer
    if (cum >= span - pxPer * 0.5) { idx = i; break }
  }
  if (idx <= 0 || idx >= text.length - 1) return null
  // 微調到較自然的斷點（空白 / 標點 / 中英交界）
  const score = j => {
    if (j <= 0 || j >= text.length) return -1
    const a = text[j - 1], b = text[j]
    if (/\s/.test(a) && !/\s/.test(b)) return 100
    if (/[）)」】。！？]/.test(a)) return 80
    if (/[一-鿿]/.test(a) !== /[一-鿿]/.test(b)) return 40
    return 0
  }
  let best = idx, bs = score(idx)
  for (let d = 1; d <= 14; d++) for (const j of [idx - d, idx + d]) {
    const s = score(j); if (s > bs) { bs = s; best = j }
  }
  const left = clean(text.slice(0, best)), right = clean(text.slice(best))
  if (!left || !right) return null
  return [
    { x: part.x, w: span, text: left },
    { x: next, w: part.w - span, text: right },
  ]
}

/**
 * 依 x 縮排把一題的內容行切成「題幹續行 + 四個選項」。
 *
 * 郵局卷（svc.tabf / 三民）的選項**沒有 (A)(B)(C)(D) 標記**，只靠縮排：
 *   x601 【3】14.依郵政法有關郵件投遞之規定，下列敘述何者錯誤？   ← 題幹，最左
 *   x616 除另有約定外，各類郵件應按其表面所書收件人之地址投遞     ← 選項 A
 *   x616 收件地址係地面層以外樓層…各類郵件得交該管理服務人員或郵件收
 *   x626 發處收領                                              ← **續行，往右再縮排**
 *   x616 收件地址係地面層以外樓層，地面層未設有…                 ← 選項 C
 *
 * 下面的 collectOptions() 是「取前四段」，選項一換行就整組錯位：續行被算成一個
 * 選項，真正的第四個選項掉出去，題幹還會吃掉選項 A（post-outdoor 114 #14 實測）。
 *
 * ⚠️ 選項起始 x 要用**眾數**，不能用最小值。題幹換行時題幹續行才是最左的，
 * 用最小值會把題幹續行當成選項 A（repair-post-options.js 的寫法有這個限制，
 * 它只處理已知壞掉的題所以沒踩到）。四個選項一定對齊同一個 x，那個 x 的
 * 出現次數必定 ≥4，續行與題幹續行都湊不到這個數。
 *
 * 湊不出剛好四個就回 null 交給舊路徑 —— 兩個選項被 mupdf 併成同一行的卷
 * （splitByColumn 處理的那種）會走到那裡。
 */
function optionsByIndent(stemX, contentLines) {
  if (contentLines.length < 4) return null
  const sorted = [...contentLines].sort((a, b) => a.y - b.y || a.x - b.x)
  const hist = new Map()
  for (const l of sorted) hist.set(l.x, (hist.get(l.x) || 0) + 1)
  const optX = [...hist.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]
  if (hist.get(optX) < 4) return null
  // 選項不會排在題號【的左邊。跨頁時補進來的「另一大欄」x 基準差很多，也在這裡擋掉。
  if (optX < stemX - 4) return null
  if (Math.max(...sorted.map(l => l.x)) - optX > 80) return null

  const opts = []
  let stemTail = ''
  for (const l of sorted) {
    if (Math.abs(l.x - optX) <= 4) opts.push(l.text)
    else if (l.x > optX) {
      if (!opts.length) return null                  // 選項還沒開始就先出現續行 → 判斷錯了
      opts[opts.length - 1] += l.text
    } else if (!opts.length) stemTail += l.text       // 還在題幹（題幹續行比選項更左）
    else return null                                  // 選項開始後又跑出更左的行 → 判斷錯了
  }
  if (opts.length !== 4) return null
  return { stemTail, opts }
}

// 從一組 rows（索引 start 起算為選項區）湊出 4 個選項 part；湊不齊回 null
function collectOptions(rows, start, colXs) {
  let parts = rows.slice(start).flatMap(r => r.parts)
    .map(p => ({ x: p.x || 0, w: p.w || 0, text: stripPUA(p.text) }))
  let guard = 0
  while (parts.length < 4 && guard++ < 6) {
    const widest = [...parts].sort((a, b) => b.w - a.w)[0]
    if (!widest) break
    const split = splitByColumn(widest, colXs)
    if (!split) break
    parts.splice(parts.indexOf(widest), 1, ...split)
  }
  if (parts.length < 4) return null
  return parts.slice(0, 4)
}

// 題塊（不含【X】num. 前綴的內容）→ { question, options } 或 null
function buildQuestion(firstText, contentLines, colXs, stemX) {
  // 先試 x 縮排（郵局卷的主要版面）；失敗才退回下面的 part 切法
  const byIndent = optionsByIndent(stemX, contentLines)
  if (byIndent) {
    const opts = byIndent.opts.map(clean)
    const question = clean(String(firstText || '') + byIndent.stemTail)
    if (question && opts.every(Boolean) && new Set(opts).size === 4 && !opts.some(o => CUT_RE.test(o))) {
      return { question, options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] } }
    }
  }

  const rows = groupRows([
    ...(firstText ? [{ y: -1, x: 0, w: 999, text: firstText }] : []),
    ...contentLines,
  ])
  if (!rows.length) return null

  // 選項區起點：第一個「多 part 選項列」；都沒有則假設「每行一個選項」取末 4 行
  let optStart = rows.findIndex(isOptionRow)
  if (optStart < 1) optStart = rows.length >= 5 ? rows.length - 4 : -1
  if (optStart < 1) return null

  // 嘗試從 optStart 組選項；湊不到 4 就往前回收題幹尾行（上行選項常被 mupdf 併成單 part
  // 而漏判為選項列），最多回收 2 行。
  let optionParts = null, used = optStart
  for (let s = optStart; s >= Math.max(1, optStart - 2); s--) {
    const got = collectOptions(rows, s, colXs)
    if (got) { optionParts = got; used = s; break }
  }
  if (!optionParts) return null

  const questionText = rows.slice(0, used).flatMap(r => r.parts.map(p => p.text)).join('')
  const opts = optionParts.map(p => clean(p.text))
  if (opts.some(o => !o)) return null
  const question = clean(questionText)
  if (!question) return null
  return { question, options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] } }
}

/**
 * 解析一份郵局專業職(二) 試題解答 PDF
 * @returns {Array<{number,answer,disputed,question,options}>}
 */
async function parsePostPdf(buf) {
  const pages = await loadPages(buf)

  // 1) 找所有題錨
  const anchors = []
  pages.forEach((lines, pi) => {
    lines.forEach((ln, li) => {
      const m = ln.text.match(ANCHOR_RE)
      if (!m) return
      const info = interpretMarker(m[1])
      if (!info) return
      anchors.push({ pi, li, x: ln.x, y: ln.y, num: +m[2], firstText: m[3] || '', ...info })
    })
  })
  if (!anchors.length) return []

  // 2) 大欄分界：右欄錨點最小 x 往左退一點
  const axs = [...new Set(anchors.map(a => a.x))].sort((a, b) => a - b)
  let split = Infinity
  for (let i = 1; i < axs.length; i++) {
    if (axs[i] - axs[i - 1] > 150) { split = axs[i] - 60; break }
  }
  const colOf = x => (x < split ? 0 : 1)

  // 3) 收集每頁的選項欄位 x 直方圖
  const xHist = new Map()
  for (const lines of pages) for (const r of groupRows(lines)) {
    if (!isOptionRow(r)) continue
    for (const p of r.parts) xHist.set(p.x, (xHist.get(p.x) || 0) + 1)
  }
  const colXs = [...xHist.entries()].filter(([, c]) => c >= 3).map(([x]) => x).sort((a, b) => a - b)

  // 4) 題錨排序：頁 → 大欄 → y
  anchors.sort((a, b) => a.pi - b.pi || colOf(a.x) - colOf(b.x) || a.y - b.y)

  // 題號連續性過濾：剔除明顯跳號的誤判錨點
  const filtered = []
  for (const a of anchors) {
    const prev = filtered[filtered.length - 1]
    if (!prev || a.num > prev.num) filtered.push(a)
  }

  // 5) 逐題切塊
  const out = []
  for (let i = 0; i < filtered.length; i++) {
    const a = filtered[i]
    const next = filtered[i + 1]
    const aCol = colOf(a.x)
    const lines = pages[a.pi]
    // 同頁同欄、y 在 a 之後的內容行
    let content = lines.filter(ln =>
      colOf(ln.x) === aCol && ln.y > a.y + 2 &&
      !ln.text.match(ANCHOR_RE)
    )
    // 結束邊界
    if (next && next.pi === a.pi && colOf(next.x) === aCol) {
      content = content.filter(ln => ln.y < next.y - 2)
    } else if (next && next.pi === a.pi && colOf(next.x) > aCol) {
      // 換到右欄：本欄到底即可
    } else if (next && next.pi > a.pi) {
      // 跨頁：補下一頁開頭到 next 之前（同欄）
      const np = pages[next.pi]
      const tail = np.filter(ln =>
        colOf(ln.x) === colOf(next.x) && ln.y < next.y - 2 && !ln.text.match(ANCHOR_RE)
      ).map(ln => ({ ...ln, y: ln.y + 100000 }))
      content = content.concat(tail)
    }
    const q = buildQuestion(a.firstText, content, colXs, a.x)
    if (!q) { out.push({ number: a.num, answer: a.answer, disputed: a.disputed, incomplete: true }); continue }
    out.push({
      number: a.num, answer: a.answer,
      ...(a.disputed ? { disputed: true } : {}),
      question: q.question, options: q.options,
    })
  }
  return out
}

module.exports = { parsePostPdf, clean, interpretMarker }
