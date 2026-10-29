/**
 * 用 PUA 選項標記的**幾何位置**重建題幹與四個選項。
 *
 * 為什麼要另寫一支：fill-civil-gaps.js 的 `paperQuestions()` 在某些卷上四個選項
 * 全空（2026-10-15 清點：34 題）。看座標就知道為什麼——標記與它標的文字
 * **不在同一個 y**（字型不同，bbox 差 1px），而且一列裡可能有兩到四個選項：
 *
 *   #3（兩欄，標記自成一行）
 *     y=105 x= 71 "Adequate Intake"      y=105 x=144 "（AI）"
 *     y=105 x=324 "Estimated Average…"   y=105 x=467 "（EAR）"
 *     y=106 x= 60 Ⓐ                      y=106 x=313 Ⓑ
 *
 *   #7（四欄，標記與值同一行）
 *     y=371 x=60 Ⓐ  x=71 "1"   x=185 Ebb  x=196 "2"   x=313 Ⓒ …
 *
 * 判準是確定性的，不是啟發式：**標記就是標籤**。一列裡依 x 排序掃過去，
 * 遇到標記就切換當前選項，其餘文字接到當前選項後面。欄位版型（Ⓐ Ⓑ 在上列、
 * Ⓒ Ⓓ 在下列）與換行版型（選項文字續到下一列）都自然成立。
 *
 * ⚠️ 這支只當**後備**用：現有解析器解得出乾淨選項時不要改用它。
 */

const MARK = { '': 'A', '': 'B', '': 'C', '': 'D' }
const MARK_RE = /[-]/
const L = ['A', 'B', 'C', 'D']
const ROW_TOL = 3          // 標記與文字的 y 差 1px，容差要大於它
const NUM_X = 56           // 題號在最左邊

/** 頁首／頁尾，不屬於任何題。不濾掉會黏進最後一個選項
 *  （營養師 108020 #29 的 D 變成「視網醇結合蛋白濃度代號：10350頁次：」）。 */
const HEADER_RE = /代號[：:]|頁次[：:]|座號[：:]|^\s*\d+\s*[-－]\s*\d+\s*$/

const clean = s => String(s || '')
  .replace(/[-​-‏﻿]/g, '')
  .replace(/\s+/g, ' ')
  .trim()

/**
 * 跟 clean() 一樣，但**保留頭尾各一個空白**。
 *
 * 選項文字是好幾個 run 接起來的，而 PDF 裡的空格就在 run 的邊緣：
 *   "The" + " Intelligence of Human Beings. "
 * 每段都 trim 再 join('') 就變成「TheIntelligence of Human Beings.」。
 * 全站有 87 題的選項帶著這種黏字（medlab 36、pt 8、police4 7…）。
 * 用 PDF 自己的空白判斷，不是靠猜哪裡該斷詞。
 */
const keep = s => (/^\s/.test(String(s || '')) ? ' ' : '') + clean(s) + (/\s$/.test(String(s || '')) ? ' ' : '')

/** 一頁的 run → 依 y 分列，列內依 x 排序。 */
function rowsOf(runs) {
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x)
  const rows = []
  for (const r of sorted) {
    const last = rows[rows.length - 1]
    if (last && Math.abs(last.y - r.y) <= ROW_TOL) last.parts.push(r)
    else rows.push({ y: r.y, parts: [r] })
  }
  for (const row of rows) row.parts.sort((a, b) => a.x - b.x)
  return rows
}

/**
 * @param {Buffer} buf 考選部試題 PDF
 * @returns {Promise<Map<number,{stem:string,options:{A,B,C,D}}>>}
 */
async function markerOptions(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const allRows = []
  for (let p = 0; p < doc.countPages(); p++) {
    const st = JSON.parse(doc.loadPage(p).toStructuredText('preserve-images').asJSON())
    const runs = []
    for (const b of st.blocks || []) {
      if (b.type && b.type !== 'text') continue
      for (const ln of b.lines || []) {
        const t = ln.text || ''
        if (!t.trim() && !MARK_RE.test(t)) continue
        if (HEADER_RE.test(t)) continue
        runs.push({ x: Math.round(ln.bbox.x), y: Math.round(ln.bbox.y), t })
      }
    }
    for (const row of rowsOf(runs)) allRows.push({ ...row, page: p })
  }

  // 題號錨點：整列最左邊那一段只有數字，而且 x 很小
  const anchors = []
  allRows.forEach((row, i) => {
    const first = row.parts[0]
    if (!first || first.x > NUM_X) return
    const m = String(first.t).trim().match(/^(\d{1,3})\s*[.．、]?$/)
    if (!m) return
    anchors.push({ i, num: +m[1] })
  })

  const out = new Map()
  for (let a = 0; a < anchors.length; a++) {
    const from = anchors[a].i
    const to = a + 1 < anchors.length ? anchors[a + 1].i : allRows.length
    const num = anchors[a].num
    const stemParts = []
    const opts = { A: [], B: [], C: [], D: [] }
    let cur = null
    for (let r = from; r < to; r++) {
      for (const part of allRows[r].parts) {
        // 題號那一段本身不要進題幹
        if (r === from && part === allRows[r].parts[0]) continue
        const t = String(part.t)
        if (MARK_RE.test(t)) {
          // 一段裡可能黏著多個標記，依標記切開
          for (const seg of t.split(/(?=[-])/)) {
            const k = MARK[seg[0]]
            if (k) { cur = k; const rest = keep(seg.slice(1)); if (rest.trim()) opts[cur].push(rest) }
            else if (cur) opts[cur].push(keep(seg))
            else stemParts.push(keep(seg))
          }
          continue
        }
        if (cur) opts[cur].push(keep(t))
        else stemParts.push(keep(t))
      }
    }
    const options = {}
    for (const k of L) options[k] = opts[k].join('').replace(/\s+/g, ' ').trim()
    out.set(num, { stem: stemParts.join('').replace(/\s+/g, ' ').trim(), options })
  }
  return out
}

module.exports = { markerOptions }
