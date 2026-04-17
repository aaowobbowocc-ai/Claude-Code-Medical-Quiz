// Column-aware MoEX PDF parser, extracted from scrape-gaps-2026-04.js for
// reuse by the shared-bank scrape path.
//
// Why column-aware: post-reform civil-service papers (高考/普考 法學知識與英文)
// use a two-column option layout where each option has no explicit A/B/C/D
// label — pdf-parse flattens this into unlabeled consecutive lines that the
// naive parser (parseQuestionsPdf in scrape-moex.js) can't reconstruct. This
// parser uses mupdf bbox data to recover column positions and reassemble the
// 4 options per question from their x-coordinates.
//
// Copied verbatim from scrape-gaps-2026-04.js ~line 132-537 (parseColumnAware,
// parseAnswers, parseAnswersColumnAware). If you fix bugs here, check whether
// scrape-gaps-2026-04.js needs the same fix — the copies will drift otherwise.

const stripPUA = s => s.replace(/[\uE000-\uF8FF]/g, '')

async function parseColumnAware(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n = doc.countPages()


  function parsePage(pg) {
    const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
    const lines = []
    for (const b of parsed.blocks) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const t = (ln.text || '').trim()
        if (!t) continue
        const fs = (ln.font && ln.font.size) || ln.bbox.h || 12
        lines.push({
          y: Math.round(ln.bbox.y), x: Math.round(ln.bbox.x),
          w: Math.round(ln.bbox.w), h: Math.round(ln.bbox.h),
          fs: Math.round(fs * 10) / 10, text: t,
        })
      }
    }
    lines.sort((a, b) => a.y - b.y || a.x - b.x)
    return lines
  }

  function findAnchors(lines, isFirstPage) {
    const anchors = []
    for (const ln of lines) {
      if (ln.x > 60) continue
      if (ln.w > 22) continue
      const m = ln.text.match(/^(\d{1,3})$/)
      if (!m) continue
      const num = +m[1]
      if (num < 1 || num > 120) continue
      if (isFirstPage && ln.y < 180) continue
      anchors.push({ num, y: ln.y, x: ln.x })
    }
    const seen = new Set()
    return anchors.filter(a => { if (seen.has(a.num)) return false; seen.add(a.num); return true })
  }

  function extractQuestionFromContent(content, columnHistogram) {
    if (!content.length) return null
    const rows = []
    for (const ln of content) {
      const last = rows[rows.length - 1]
      const clone = { y: ln.y, x: ln.x, w: ln.w, h: ln.h, fs: ln.fs, text: ln.text }
      if (last && Math.abs(last.y - ln.y) <= 5) last.parts.push(clone)
      else rows.push({ y: ln.y, parts: [clone] })
    }
    for (const r of rows) r.parts.sort((a, b) => a.x - b.x)

    const minX = Math.min(...rows.flatMap(r => r.parts.map(p => p.x)))
    for (let i = rows.length - 1; i > 0; i--) {
      const r = rows[i]
      if (r.parts.length === 1 && r.parts[0].x > minX + 8) {
        const prev = rows[i - 1]
        const lastPart = prev.parts[prev.parts.length - 1]
        lastPart.text += r.parts[0].text
        rows.splice(i, 1)
      }
    }

    const isOptionRow = r => {
      if (r.parts.length < 2) return false
      const xs = r.parts.map(p => p.x).sort((a, b) => a - b)
      let wideGap = false
      for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > 50) { wideGap = true; break }
      if (!wideGap) return false
      const maxW = Math.max(...r.parts.map(p => p.w || 0))
      return maxW < 260
    }
    const optIdxs = rows.map((r, i) => isOptionRow(r) ? i : -1).filter(i => i >= 0)

    let questionRows, optionParts
    if (optIdxs.length > 0) {
      const firstOpt = optIdxs[0]
      questionRows = rows.slice(0, firstOpt)
      optionParts = []
      for (const r of rows.slice(firstOpt)) for (const p of r.parts) optionParts.push(p)
    } else {
      if (rows.length < 4) return null
      questionRows = rows.slice(0, rows.length - 4)
      optionParts = rows.slice(rows.length - 4).map(r => r.parts[0])
    }

    while (optionParts.length < 4) {
      const wides = optionParts.map((p, i) => ({ p, i, w: p.w || p.text.length * 10 }))
        .sort((a, b) => b.w - a.w)
      let progressed = false
      for (const cand of wides) {
        const origText = cand.p.text
        const offsetMap = []
        let stripped = ''
        for (let i = 0; i < origText.length; i++) {
          const code = origText.charCodeAt(i)
          if (code >= 0xE000 && code <= 0xF8FF) continue
          offsetMap.push(i)
          stripped += origText[i]
        }
        const text = stripped
        const patterns = [
          /([）)])([^\s，。；、])/,
          /([。！？])([^\s，。；、)])/,
          /([倍件條項個種類型次年月日時分秒級度])([0-9０-９])/,
          /([\u4e00-\u9fff])([A-Za-zＡ-Ｚａ-ｚ])/,
          /([\u4e00-\u9fff])([0-9０-９])/,
          /([0-9０-９])([\u4e00-\u9fff])/,
        ]
        let splitAtStripped = -1
        for (const re of patterns) {
          const mid = Math.floor(text.length / 2)
          const range = Math.floor(text.length * 0.35)
          const slice = text.slice(mid - range, mid + range)
          const m = slice.match(re)
          if (m) { splitAtStripped = mid - range + m.index + m[1].length; break }
        }
        if (splitAtStripped > 0 && splitAtStripped < text.length) {
          const splitAt = splitAtStripped < offsetMap.length
            ? offsetMap[splitAtStripped]
            : origText.length
          const left = origText.slice(0, splitAt)
          const right = origText.slice(splitAt)
          optionParts.splice(cand.i, 1, { text: left }, { text: right })
          progressed = true
          break
        }
      }
      if (!progressed) break
    }

    if (optionParts.length < 4 && columnHistogram && columnHistogram.length >= 2) {
      while (optionParts.length < 4) {
        let progressed = false
        const widesByW = optionParts.map((p, i) => ({ p, i }))
          .sort((a, b) => (b.p.w || 0) - (a.p.w || 0))
        for (const cand of widesByW) {
          const p = cand.p
          if (!p.w || !p.fs) continue
          const startX = p.x
          const nextCol = columnHistogram.find(cx => cx > startX + 30)
          if (!nextCol) continue
          const targetSpan = nextCol - startX
          if (p.w <= targetSpan + 5) continue
          const fs = p.fs
          const origText = p.text
          const offsetMap = []
          let stripped = ''
          for (let i = 0; i < origText.length; i++) {
            const code = origText.charCodeAt(i)
            if (code >= 0xE000 && code <= 0xF8FF) continue
            offsetMap.push(i)
            stripped += origText[i]
          }
          const charWeight = c => /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(c) ? 1.0 : 0.55
          const totalWeight = [...stripped].reduce((s, c) => s + charWeight(c), 0)
          const pxPerWeight = totalWeight > 0 ? p.w / totalWeight : fs
          let cum = 0
          let splitIdx = -1
          for (let j = 0; j < stripped.length; j++) {
            cum += charWeight(stripped[j]) * pxPerWeight
            if (cum >= targetSpan - pxPerWeight * 0.5) { splitIdx = j; break }
          }
          if (splitIdx <= 0 || splitIdx >= stripped.length - 1) continue
          const isCJK = c => /[\u4e00-\u9fff]/.test(c)
          const isSpace = c => /\s/.test(c)
          const isBracket = c => /[）)」】]/.test(c)
          const isPunct = c => /[。！？；]/.test(c)
          const score = j => {
            if (j <= 0 || j >= stripped.length) return -1
            const prev = stripped[j - 1], cur = stripped[j]
            if (isSpace(prev) && !isSpace(cur)) return 100
            if (!isSpace(prev) && isSpace(cur)) return 95
            if (isBracket(prev)) return 90
            if (isPunct(prev)) return 85
            if (isCJK(prev) !== isCJK(cur)) return 60
            return 0
          }
          let bestIdx = splitIdx, bestScore = score(splitIdx)
          for (let d = 1; d <= 12; d++) {
            for (const j of [splitIdx - d, splitIdx + d]) {
              const s = score(j)
              if (s > bestScore) { bestScore = s; bestIdx = j }
            }
            if (bestScore >= 90 && d >= 3) break
          }
          const splitAt = bestIdx < offsetMap.length ? offsetMap[bestIdx] : origText.length
          const left = stripPUA(origText.slice(0, splitAt)).trim()
          const right = stripPUA(origText.slice(splitAt)).trim()
          if (!left || !right) continue
          optionParts.splice(cand.i, 1,
            { text: left, x: startX, w: targetSpan, fs },
            { text: right, x: nextCol, w: (p.w - targetSpan), fs },
          )
          progressed = true
          break
        }
        if (!progressed) break
      }
    }

    if (optionParts.length < 4) return null
    const opts = optionParts.slice(0, 4).map(p => p.text.trim())
    const question = questionRows.map(r => r.parts.map(p => p.text).join('')).join('').trim()
    if (!question) return null
    return { question, options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] } }
  }

  const pageData = []
  for (let i = 0; i < n; i++) {
    const lines = parsePage(doc.loadPage(i))
    pageData.push({ lines, anchors: findAnchors(lines, i === 0) })
  }
  const isAnchorLine = ln => ln.x <= 60 && ln.w <= 22 && /^\d{1,3}$/.test(ln.text)
  const isHeaderLine = ln => /^(代號|頁次|類\s*科|科\s*目|考試時間|等\s*別|本試題|座號|※\s*注意|頁\s*次)/.test(ln.text)

  const xCounts = new Map()
  for (const { lines } of pageData) {
    const rows = []
    for (const ln of lines) {
      if (isAnchorLine(ln)) continue
      const last = rows[rows.length - 1]
      if (last && Math.abs(last.y - ln.y) <= 5) last.parts.push(ln)
      else rows.push({ y: ln.y, parts: [ln] })
    }
    for (const r of rows) {
      r.parts.sort((a, b) => a.x - b.x)
      if (r.parts.length < 2) continue
      const xs = r.parts.map(p => p.x)
      let wide = false
      for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > 50) { wide = true; break }
      if (!wide) continue
      const maxW = Math.max(...r.parts.map(p => p.w || 0))
      if (maxW > 260) continue
      for (const p of r.parts) {
        const k = p.x
        xCounts.set(k, (xCounts.get(k) || 0) + 1)
      }
    }
  }
  const sortedX = [...xCounts.entries()].sort((a, b) => b[1] - a[1])
  const columnHistogram = []
  for (const [x] of sortedX) {
    if (columnHistogram.every(cx => Math.abs(cx - x) > 6)) columnHistogram.push(x)
    if (columnHistogram.length >= 4) break
  }
  columnHistogram.sort((a, b) => a - b)

  const out = {}
  for (let pi = 0; pi < pageData.length; pi++) {
    const { lines, anchors } = pageData[pi]
    for (let ai = 0; ai < anchors.length; ai++) {
      const a = anchors[ai]
      const nextA = ai + 1 < anchors.length ? anchors[ai + 1] : null
      let content
      if (nextA) {
        content = lines.filter(ln =>
          !isAnchorLine(ln) && !isHeaderLine(ln) &&
          ln.y >= a.y - 2 && ln.y < nextA.y - 2
        )
      } else if (pi + 1 < pageData.length) {
        const curTail = lines.filter(ln => !isAnchorLine(ln) && !isHeaderLine(ln) && ln.y >= a.y - 2)
        const np = pageData[pi + 1]
        const nextOnNext = np.anchors.length ? np.anchors[0] : null
        const yOffset = 2000
        const nextTail = np.lines
          .filter(ln => !isAnchorLine(ln) && !isHeaderLine(ln)
            && (nextOnNext == null || ln.y < nextOnNext.y - 2))
          .map(ln => ({ ...ln, y: ln.y + yOffset }))
        content = curTail.concat(nextTail)
      } else {
        content = lines.filter(ln => !isAnchorLine(ln) && !isHeaderLine(ln) && ln.y >= a.y - 2)
      }
      const q = extractQuestionFromContent(content, columnHistogram)
      if (q && !out[a.num]) out[a.num] = q
    }
  }
  return out
}

function parseAnswersText(text) {
  const ans = {}
  const fw = /答案\s*([ＡＢＣＤ]+)/g
  let m, n = 1
  while ((m = fw.exec(text)) !== null) {
    for (const ch of m[1]) {
      const k = ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : null
      if (k) ans[n++] = k
    }
  }
  if (Object.keys(ans).length >= 20) return ans
  const hw = /(\d{1,2})\s*[.\s、．:：]\s*([A-Da-d])/g
  while ((m = hw.exec(text)) !== null) {
    const num = parseInt(m[1])
    if (num >= 1 && num <= 80) ans[num] = m[2].toUpperCase()
  }
  return ans
}

async function parseAnswersColumnAware(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const orderedNums = [], orderedAns = []
  for (let pi = 0; pi < doc.countPages(); pi++) {
    const parsed = JSON.parse(doc.loadPage(pi).toStructuredText('preserve-images').asJSON())
    const lines = []
    for (const b of parsed.blocks) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const t = (ln.text || '').trim()
        if (!t) continue
        lines.push({ y: Math.round(ln.bbox.y), x: Math.round(ln.bbox.x), text: t })
      }
    }
    lines.sort((a, b) => a.y - b.y || a.x - b.x)
    const rows = []
    for (const ln of lines) {
      const last = rows[rows.length - 1]
      if (last && Math.abs(last.y - ln.y) <= 3) last.parts.push(ln)
      else rows.push({ y: ln.y, parts: [ln] })
    }
    for (const r of rows) {
      const nums = []
      for (const p of r.parts) {
        const m = p.text.match(/^第(\d{1,3})題$/)
        if (m) nums.push({ x: p.x, num: +m[1] })
      }
      if (nums.length >= 2) {
        nums.sort((a, b) => a.x - b.x)
        for (const nn of nums) orderedNums.push(nn.num)
        continue
      }
      const hasLabel = r.parts.some(p => p.text === '答案')
      if (!hasLabel) continue
      const letters = []
      for (const p of r.parts) {
        if (p.text === '答案') continue
        if (/^[A-D]$/.test(p.text)) letters.push({ x: p.x, ch: p.text })
        else if (/^[ＡＢＣＤ]$/.test(p.text)) {
          const ch = p.text === 'Ａ' ? 'A' : p.text === 'Ｂ' ? 'B' : p.text === 'Ｃ' ? 'C' : 'D'
          letters.push({ x: p.x, ch })
        }
      }
      if (letters.length >= 2) {
        letters.sort((a, b) => a.x - b.x)
        for (const l of letters) orderedAns.push(l.ch)
      }
    }
  }
  const ans = {}
  const len = Math.min(orderedNums.length, orderedAns.length)
  for (let i = 0; i < len; i++) ans[orderedNums[i]] = orderedAns[i]
  return ans
}

module.exports = { parseColumnAware, parseAnswersColumnAware, parseAnswersText, stripPUA }
