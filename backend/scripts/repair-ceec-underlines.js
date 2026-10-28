#!/usr/bin/env node
/**
 * 把大考中心試卷的「底線」還原進題庫。
 *
 * 使用者回饋（id 117）第三點：「題目說畫底線答案也沒有底線，雖然大概可以
 * 判斷但真的很不方便」。前兩點（題組缺題文、題文跑進選項）已修，這是最後一點。
 *
 * 底線在 PDF 裡**不是文字而是繪圖指令**，pdf-parse 抽不到。
 * 用 mupdf 的 Device 攔截 fillPath／strokePath，找「很扁很長」的路徑：
 *   111 學測國綜第 2 頁有四條等距的 w=48 h=1 橫線（y=314/330/345/362），
 *   正是第 3 題四個選項裡的底線。
 *
 * ⚠️ Path.getBounds() 需要 StrokeState 參數，fillPath 沒有 →
 *    改用 path.walk() 自己收點算邊界。
 *
 * 標記用 `﹍`（U+FE4D 虛線底線）把底線範圍包起來：﹍運用不適當﹍
 *   - 題幹是純文字渲染（Practice.jsx 的 {q.question}），HTML/Markdown 會原樣顯示
 *   - 組合字元 U+0332 會讓 skeleton() 算出不同結果 → 害搜尋與比對失效
 *     （全站已有 123 個組合字元，不能靠改 skeleton 解決）
 *   - `﹍` 實測 skeleton() 會剝掉，搜尋不受影響
 *
 *   node scripts/repair-ceec-underlines.js --exam=gsat --year=111
 *   加 --apply 才寫入
 */
const fs = require('fs')
const path = require('path')
const https = require('https')
const { REGISTRY, BASE } = require('./scrape-ceec')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1]
const ONLY_EXAM = arg('exam')
const ONLY_YEAR = arg('year')
const U = '﹍'
const L = ['A', 'B', 'C', 'D', 'E']
const norm = s => String(s || '').replace(/\s+/g, '')

function download(url, r = 0) {
  return new Promise((res, rej) => {
    const full = url.startsWith('http') ? url : BASE + url
    https.get(full, { headers: { 'User-Agent': 'Mozilla/5.0' } }, x => {
      if ([301, 302, 303, 307, 308].includes(x.statusCode) && r < 5)
        return res(download(new URL(x.headers.location, full).href, r + 1))
      if (x.statusCode !== 200) return rej(new Error('HTTP ' + x.statusCode))
      const b = []; x.on('data', d => b.push(d)).on('end', () => res(Buffer.concat(b)))
    }).on('error', rej)
  })
}

/** 一頁的底線矩形。 */
function underlineRects(mupdf, page) {
  const out = []
  const push = (p, ctm) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    const pt = (x, y) => {
      const X = ctm[0] * x + ctm[2] * y + ctm[4]
      const Y = ctm[1] * x + ctm[3] * y + ctm[5]
      if (X < x0) x0 = X; if (X > x1) x1 = X
      if (Y < y0) y0 = Y; if (Y > y1) y1 = Y
    }
    try {
      p.walk({ moveTo: pt, lineTo: pt, curveTo: (a, b, c, d, e, f) => { pt(a, b); pt(c, d); pt(e, f) }, closePath() {} })
    } catch { return }
    if (!isFinite(x0)) return
    // 底線：很扁（<2.5）、夠長（>10）
    if (y1 - y0 <= 2.5 && x1 - x0 > 10) out.push({ x0, x1, y: (y0 + y1) / 2 })
  }
  const noop = () => {}
  const dev = new mupdf.Device({
    fillPath: (p, eo, ctm) => push(p, ctm),
    strokePath: (p, s, ctm) => push(p, ctm),
    clipPath: noop, clipStrokePath: noop, fillText: noop, strokeText: noop, clipText: noop,
    clipStrokeText: noop, ignoreText: noop, fillShade: noop, fillImage: noop, fillImageMask: noop,
    clipImageMask: noop, popClip: noop, beginMask: noop, endMask: noop, beginGroup: noop,
    endGroup: noop, beginTile: () => 0, endTile: noop, beginLayer: noop, endLayer: noop, close: noop,
  })
  try { page.run(dev, mupdf.Matrix.identity) } catch { /* 有些頁跑不動 */ }
  return out
}

/**
 * 一頁的逐字座標。
 *
 * ⚠️ toStructuredText().asJSON() **沒有** chars 欄位，只有行層級的 bbox。
 *    一開始用「行 bbox 依字數內插」去推哪些字在底線上方，結果會偏移一格
 *    （111 國文 #3 的 D 標成「陷﹍入進退維﹍谷」，正解是「﹍進退維谷﹍」）。
 *    StructuredText.walk() 的 onChar 會給每個字精確的 quad，用它才準。
 */
function pageChars(stx) {
  const out = []
  const noop = () => {}
  stx.walk({
    onChar(c, origin, font, size, quad) {
      // quad 是 8 個數字：左上 右上 左下 右下
      const xs = [quad[0], quad[2], quad[4], quad[6]]
      const ys = [quad[1], quad[3], quad[5], quad[7]]
      out.push({ c, x0: Math.min(...xs), x1: Math.max(...xs), y1: Math.max(...ys) })
    },
    beginLine: noop, endLine: noop, beginTextBlock: noop, endTextBlock: noop,
    beginStruct: noop, endStruct: noop, onImageBlock: noop,
  })
  return out
}

/** 底線正上方的那串字。 */
function charsAbove(chars, r) {
  const hit = chars.filter(ch =>
    ch.x1 > r.x0 + 0.5 && ch.x0 < r.x1 - 0.5 &&     // x 要真的重疊
    ch.y1 <= r.y + 2 && ch.y1 >= r.y - 18)          // 字的下緣就在底線上方
  if (hit.length < 2) return null

  /*
   * ⚠️ 18pt 的 y 容許範圍會跨到相鄰那一行。同一條 y 帶裡若有兩個選項各自的
   *    底線，依 x 排序就會把兩組字交錯合併 ——
   *    「自斷後路」＋「頭角崢嶸」被湊成「自頭斷角後崢路嶸」。
   *    所以先依字的下緣分行，只取最貼近底線的那一行。
   */
  const rows = new Map()
  for (const ch of hit) {
    const key = Math.round(ch.y1)
    if (!rows.has(key)) rows.set(key, [])
    rows.get(key).push(ch)
  }
  const best = [...rows.entries()].sort(
    (a, b) => Math.abs(a[0] - r.y) - Math.abs(b[0] - r.y))[0][1]
  best.sort((a, b) => a.x0 - b.x0)
  const seg = best.map(h => h.c).join('').trim()
  return seg.length >= 2 ? seg : null
}

/** （舊的內插法，留著對照用，已不使用） */
function textAbove(lines, r) {
  // 底線在字的下緣再下面一點點：取 y 在 [r.y-20, r.y+2] 之間、x 有重疊的行
  // ⚠️ mupdf 的 bbox 是物件 {x,y,w,h} 不是陣列（extract-ceec-figures.js 也是這樣讀）
  const B = l => ({ x0: l.bbox.x, y0: l.bbox.y, x1: l.bbox.x + l.bbox.w, y1: l.bbox.y + l.bbox.h })
  const cands = lines.filter(l => {
    const b = B(l)
    return b.y1 <= r.y + 3 && b.y1 >= r.y - 22 && b.x0 < r.x1 && b.x1 > r.x0
  })
  if (!cands.length) return null
  // 取最靠近底線的那一行
  cands.sort((a, b) => Math.abs(B(a).y1 - r.y) - Math.abs(B(b).y1 - r.y))
  const l = cands[0]
  const t = l.text || ''
  if (!t) return null
  const lx0 = B(l).x0, lx1 = B(l).x1
  const w = lx1 - lx0
  if (w <= 0) return null
  const chars = [...t]
  const i0 = Math.max(0, Math.round((r.x0 - lx0) / w * chars.length))
  const i1 = Math.min(chars.length, Math.round((r.x1 - lx0) / w * chars.length))
  const seg = chars.slice(i0, i1).join('').trim()
  return seg.length >= 2 ? seg : null
}

;(async () => {
  const mupdf = await import('mupdf')
  let marked = 0
  const skip = {}
  const bump = k => { skip[k] = (skip[k] || 0) + 1 }

  for (const [examId, def] of Object.entries(REGISTRY)) {
    if (ONLY_EXAM && examId !== ONLY_EXAM) continue
    const file = path.join(BK, def.outputFile)
    if (!fs.existsSync(file)) continue
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    const arr = j.questions || j
    let touched = false

    for (const [year, subjects] of Object.entries(def.years)) {
      if (ONLY_YEAR && year !== ONLY_YEAR) continue
      for (const sd of def.subjects) {
        const urls = subjects[sd.tag]
        if (!urls || !urls.q) continue
        const code = `${examId}_${year}`
        // 只處理題幹或選項提到「底線」的題
        const mine = arr.filter(q => q.exam_code === code && q.subject === sd.name &&
          /底線/.test([q.question, ...L.map(k => q.options?.[k])].map(x => String(x || '')).join('')))
        if (!mine.length) continue

        let doc
        try { doc = mupdf.Document.openDocument(await download(urls.q), 'application/pdf') }
        catch (e) { console.warn(`  ${code} ${sd.name}: 原卷取不到`); continue }

        // 收集全卷的「底線 → 文字」
        const segs = []
        for (let p = 0; p < doc.countPages(); p++) {
          const page = doc.loadPage(p)
          const chars = pageChars(page.toStructuredText('preserve-whitespace'))
          for (const r of underlineRects(mupdf, page)) {
            const seg = charsAbove(chars, r)
            // 只收「乾淨的詞」：2~10 字、沒有空白與標點。
            // 不設限的話表格框線、方框邊也會被當底線，撈出一堆雜訊
            // （111 國綜一卷就撈到 55 段，其中多數是假的，還把題幹誤標）。
            if (!seg) continue
            // ⚠️ 兩字詞（「沒有」）在題庫裡到處都是，拿去比對會亂標 → 至少三字。
            //    「為題組」「(A)」這些在原卷上確實有底線，但那是版面標記不是題目內容。
            if (seg.length < 3 || seg.length > 10) continue
            if (/[\s，。、；：？！()（）「」『』《》…—－]/.test(seg)) continue
            if (/題組|^\d|^[A-E]$/.test(seg)) continue
            segs.push(seg)
          }
        }
        if (process.argv.includes('--show')) {
          console.log(`  [debug] ${code} ${sd.name} 底線候選 ${segs.length} 段：`)
          for (const x of segs) console.log('      ' + JSON.stringify(x))
        }
        if (!segs.length) { bump('原卷抓不到底線'); continue }

        let n = 0
        for (const q of mine) {
          for (const field of ['question', ...L.map(k => `options.${k}`)]) {
            const [g, k] = field.split('.')
            const cur = k ? q.options?.[k] : q[g]
            if (!cur) continue
            let s = String(cur)
            if (s.includes(U)) continue                 // 冪等
            let hit = false
            for (const seg of segs) {
              if (seg.length < 2 || seg.length > 20) continue
              const i = norm(s).indexOf(norm(seg))
              if (i < 0) continue
              // 在原字串上找（容忍空白）
              const re = new RegExp([...seg].map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'))
              if (!re.test(s)) continue
              s = s.replace(re, m => `${U}${m}${U}`)
              hit = true
            }
            if (!hit) continue
            if (APPLY) { if (k) q.options[k] = s; else q[g] = s }
            n++; marked++; touched = true
            if (marked <= 10) console.log(`  ${code} ${sd.name} #${q.number} [${field}] ${s.slice(0, 64)}`)
          }
        }
        if (n) console.log(`  ${code} ${sd.name}：標記 ${n} 處（底線候選 ${segs.length} 段）`)
      }
    }
    if (touched && APPLY) fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n', 'utf8')
  }

  console.log(`\n標記 ${marked} 處${APPLY ? '' : '（dry-run）'}`)
  if (Object.keys(skip).length) console.log('跳過：' + JSON.stringify(skip))
})().catch(e => { console.error(e.stack); process.exit(1) })
