#!/usr/bin/env node
/**
 * One-shot gap-filler (2026-04-14):
 *
 *   1. tcm1 114 第一次 — code=114020, c=317, s=0301/0302  (labeled PDF)
 *   2. tcm2 114 第一次 — code=114020, c=318, s=0303/0304/0305/0306  (labeled)
 *   3. nursing 111 第二次 — code=111110, c=104, s=0301..0305  (column-based PDF)
 *
 * Why a separate script: these 3 batches need either (a) a different
 * code series than scrape-moex.js's hardcoded 030 definitions, or (b)
 * column-aware parsing (nursing 111-2 uses pre-reform layout with no
 * A/B/C/D labels).
 *
 * Runs append-only against existing JSON files; IDs start at max+1.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const fs = require('fs')
const path = require('path')
const { fetchPdf, cachedFetch, buildMoexUrl } = require('./lib/pdf-fetcher')
const https = require('https')
const pdfParse = require('pdf-parse')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')

// ─── HTTP with cache ───
function fetchPdfRaw(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 20000,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/pdf,*/*',
        'Referer': 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx',
      },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location
        if (!loc || !loc.startsWith('http')) { res.resume(); return reject(new Error(`bad redirect`)) }
        return fetchPdfRaw(loc, retries).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        if (retries > 0) return setTimeout(() => fetchPdfRaw(url, retries - 1).then(resolve, reject), 1000)
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      const cs = []
      res.on('data', c => cs.push(c))
      res.on('end', () => resolve(Buffer.concat(cs)))
    })
    req.on('error', e => retries > 0
      ? setTimeout(() => fetchPdfRaw(url, retries - 1).then(resolve, reject), 1000)
      : reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function cachedPdf(tag, kind, code, c, s) {
  // tag: short id for cache filename ('tcm1_114', 'nursing_111110', etc)
  fs.mkdirSync(PDF_CACHE, { recursive: true })
  const fname = `${tag}_${kind}_${code}_c${c}_s${s}.pdf`
  const cur = path.join(PDF_CACHE, fname)
  if (fs.existsSync(cur) && fs.statSync(cur).size > 1000) return fs.readFileSync(cur)
  const url = `${BASE}?t=${kind}&code=${code}&c=${c}&s=${s}&q=1`
  const buf = await fetchPdfRaw(url)
  fs.writeFileSync(cur, buf)
  return buf
}

// ─── Labeled-format parser (1., A./B./C./D.) — adapted from scrape-moex.js ───

function parseLabeled(text) {
  const questions = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let currentQ = null, currentOption = null, buffer = ''

  const flushOpt = () => {
    if (currentQ && currentOption) currentQ.options[currentOption] = buffer.trim()
    buffer = ''; currentOption = null
  }
  const flushQ = () => {
    flushOpt()
    if (currentQ && currentQ.question && Object.keys(currentQ.options).length === 4) questions.push(currentQ)
    currentQ = null
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^(代號|類科|科目|考試|頁次|等\s*別|本試題|座號|※|注意)/.test(line)) continue
    if (/^\d+\s*頁/.test(line) || /^第\s*\d+\s*頁/.test(line)) continue

    // Section reset: a line like "二、測驗題", "乙、測驗題", "貳、選擇題" marks
    // the start of the MCQ section after an essay section. The essay items
    // counted as "1.", "2.", "3." would otherwise leave currentQ pointing at
    // the last essay item, causing the first 2 MCQ questions to be lost
    // (their numbers fail the "currentQ.number + 1" check).
    if (/^([一二三四乙貳]、|乙[、.])\s*(測驗|選擇|單選)/.test(line)) {
      currentQ = null; currentOption = null; buffer = ''
      questions.length = 0
      continue
    }

    const qm = line.match(/^(\d{1,2})[.、．]\s*(.*)$/)
    if (qm && (line.length > 6 || /[\u4e00-\u9fff a-zA-Z]/.test(qm[2] || '') || (qm[2] || '') === '')) {
      const num = parseInt(qm[1])
      const isFirst = !currentQ && questions.length === 0
      if (num >= 1 && num <= 80 && (isFirst || (currentQ && num === currentQ.number + 1))) {
        flushQ()
        currentQ = { number: num, question: (qm[2] || '').trim(), options: {} }
        continue
      }
    }
    const om = line.match(/^[\(（]\s*([A-Da-dＡＢＣＤ])\s*[\)）]\s*(.*)$/)
      || line.match(/^([A-Da-dＡＢＣＤ])\s*[.．、]\s*(.*)$/)
    if (om && currentQ) {
      flushOpt()
      currentOption = om[1].toUpperCase()
        .replace('Ａ', 'A').replace('Ｂ', 'B').replace('Ｃ', 'C').replace('Ｄ', 'D')
      buffer = om[2] || ''
      continue
    }
    if (currentOption) buffer += ' ' + line
    else if (currentQ) currentQ.question += ' ' + line
  }
  flushQ()
  return questions
}

// ─── Column-aware parser (from scrape-tcm1-110-111.js) ───

async function parseColumnAware(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n = doc.countPages()

  // mupdf sometimes injects PUA (Private Use Area) chars as invisible markers
  // for superscripts/subscripts — they break char-class regexes during salvage.
  const stripPUA = s => s.replace(/[\uE000-\uF8FF]/g, '')

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
      if (isFirstPage && ln.y < 220) continue
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

    // Merge wrap continuations: a single-part row whose x is noticeably to
    // the right of the leftmost content column is a wrap from the previous
    // row. Compute the leftmost x dynamically (nursing uses 58, tcm1 uses 72).
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

    // An option row has multiple parts at wide-gap x positions AND each part
    // is relatively narrow (options are usually short). Question rows may
    // also have split parts (e.g. the ①②③④ enumeration in the question
    // body) but those are typically wide (>220px) or the row contains a
    // long text run.
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
    // Salvage: when mupdf merged two adjacent column cells into one part, we
    // get fewer than 4 options. Try to split the widest part on structural
    // boundaries: bracket/period (strict), unit+digit (medium), or a bare
    // CJK→digit transition (loose). Loose rules run only when we still need
    // a split after the strict ones failed.
    while (optionParts.length < 4) {
      const wides = optionParts.map((p, i) => ({ p, i, w: p.w || p.text.length * 10 }))
        .sort((a, b) => b.w - a.w)
      let progressed = false
      for (const cand of wides) {
        // Use a PUA-stripped view for regex matching — but record the offset
        // mapping so we can map matches back to the ORIGINAL text indices.
        const origText = cand.p.text
        const offsetMap = []  // offsetMap[i] = original index of stripped[i]
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
          // Map stripped index back to the original text. The split point is
          // the original index of the char at stripped[splitAtStripped] (i.e.
          // the start of the right side).
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

    // Histogram-based salvage: when structural patterns can't find a split,
    // fall back to column-x position + character-width estimation. Needs the
    // doc-level columnHistogram (the typical x positions of option columns
    // observed across the whole paper).
    if (optionParts.length < 4 && columnHistogram && columnHistogram.length >= 2) {
      while (optionParts.length < 4) {
        // Find the widest part that starts at (or near) a known column-x and
        // whose width spans into the next column. Split it at the char index
        // whose accumulated width would land on the next column boundary.
        let progressed = false
        const widesByW = optionParts.map((p, i) => ({ p, i }))
          .sort((a, b) => (b.p.w || 0) - (a.p.w || 0))
        for (const cand of widesByW) {
          const p = cand.p
          if (!p.w || !p.fs) continue
          const startX = p.x
          // Find next column boundary > startX
          const nextCol = columnHistogram.find(cx => cx > startX + 30)
          if (!nextCol) continue
          const targetSpan = nextCol - startX
          if (p.w <= targetSpan + 5) continue   // doesn't actually spill
          // Estimate char widths: prefer measured (part.w / chars) over fs heuristic.
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
          // Weight chars (CJK ≈ 1.0, ASCII ≈ 0.55) and scale to actual width
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
          // Snap to nearest natural boundary (whitespace > CJK↔ASCII transition >
          // bracket close > sentence punctuation). Search wider for whitespace
          // because ASCII-heavy options merge with no other markers.
          const isCJK = c => /[\u4e00-\u9fff]/.test(c)
          const isSpace = c => /\s/.test(c)
          const isBracket = c => /[）)」】]/.test(c)
          const isPunct = c => /[。！？；]/.test(c)
          const score = j => {
            if (j <= 0 || j >= stripped.length) return -1
            const prev = stripped[j - 1], cur = stripped[j]
            // Split right after a space (whitespace ends previous token)
            if (isSpace(prev) && !isSpace(cur)) return 100
            // Split right before a space (whitespace begins next token); the
            // trailing space gets trimmed so this is equivalent.
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
              // Prefer higher score; on tie, prefer closer to estimate
              if (s > bestScore) { bestScore = s; bestIdx = j }
            }
            // Stop early if we found a strong boundary nearby
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
  // Drop anchor-pattern lines from each page's content
  const isAnchorLine = ln => ln.x <= 60 && ln.w <= 22 && /^\d{1,3}$/.test(ln.text)
  // Header/masthead lines that appear at the top of every page — never part of question content.
  const isHeaderLine = ln => /^(代號|頁次|類\s*科|科\s*目|考試時間|等\s*別|本試題|座號|※\s*注意|頁\s*次)/.test(ln.text)

  // Build column-x histogram from rows that look like "clean" option rows
  // (2 parts with a wide gap, both narrow). The 2 dominant x positions are
  // the column starts. Used as fallback for histogram salvage.
  const xCounts = new Map()
  for (const { lines } of pageData) {
    // Group lines into rows by y
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
  // Pick the top x positions (cluster within ±4px)
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
        // Offset next-page y so it sorts after current-page y.
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

// ─── Answer / correction parsers ───

function parseAnswers(text) {
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

// Column-aware answer parser (for 111110 nursing — also a table layout)
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

function parseCorrections(text) {
  const corrections = {}
  for (const line of text.split(/\n/)) {
    const give = line.match(/第?\s*(\d{1,3})\s*題.*(?:一律給分|送分)/i)
    if (give) { corrections[parseInt(give[1])] = '*'; continue }
    const change = line.match(/第?\s*(\d{1,3})\s*題.*更正.*([ＡＢＣＤA-D])/i)
    if (change) {
      let ch = change[2]
      if (ch === 'Ａ') ch = 'A'
      else if (ch === 'Ｂ') ch = 'B'
      else if (ch === 'Ｃ') ch = 'C'
      else if (ch === 'Ｄ') ch = 'D'
      corrections[parseInt(change[1])] = ch
    }
  }
  return corrections
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── Batch definitions ───

const BATCHES = [
  {
    file: 'questions-tcm1.json',
    tag: 'tcm1_114_1',
    code: '114020',
    classCode: '317',
    year: '114',
    session: '第一次',
    parser: 'labeled',
    subjects: [
      { s: '0301', name: '中醫基礎醫學(一)', tag: 'tcm_basic_1' },
      { s: '0302', name: '中醫基礎醫學(二)', tag: 'tcm_basic_2' },
    ],
  },
  {
    file: 'questions-tcm2.json',
    tag: 'tcm2_114_1',
    code: '114020',
    classCode: '318',
    year: '114',
    session: '第一次',
    parser: 'labeled',
    subjects: [
      { s: '0303', name: '中醫臨床醫學(一)', tag: 'tcm_clinical_1' },
      { s: '0304', name: '中醫臨床醫學(二)', tag: 'tcm_clinical_2' },
      { s: '0305', name: '中醫臨床醫學(三)', tag: 'tcm_clinical_3' },
      { s: '0306', name: '中醫臨床醫學(四)', tag: 'tcm_clinical_4' },
    ],
  },
  {
    file: 'questions-nursing.json',
    tag: 'nursing_111_2',
    code: '111110',
    classCode: '104',
    year: '111',
    session: '第二次',
    parser: 'column',
    subjects: [
      { s: '0301', name: '基礎醫學', tag: 'basic_medicine' },
      { s: '0302', name: '基本護理學與護理行政', tag: 'fundamentals_admin' },
      { s: '0303', name: '內外科護理學', tag: 'med_surg' },
      { s: '0304', name: '產兒科護理學', tag: 'ob_peds' },
      { s: '0305', name: '精神科與社區衛生護理學', tag: 'psych_community' },
    ],
  },
  // tcm2 110-111 (both sessions) — column format, c=102 (pre-reform class code reuse)
  {
    file: 'questions-tcm2.json',
    tag: 'tcm2_110_1',
    code: '110030',
    classCode: '102',
    year: '110',
    session: '第一次',
    parser: 'column',
    subjects: [
      { s: '0103', name: '中醫臨床醫學(一)', tag: 'tcm_clinical_1' },
      { s: '0104', name: '中醫臨床醫學(二)', tag: 'tcm_clinical_2' },
      { s: '0105', name: '中醫臨床醫學(三)', tag: 'tcm_clinical_3' },
      { s: '0106', name: '中醫臨床醫學(四)', tag: 'tcm_clinical_4' },
    ],
  },
  {
    file: 'questions-tcm2.json',
    tag: 'tcm2_110_2',
    code: '110111',
    classCode: '102',
    year: '110',
    session: '第二次',
    parser: 'column',
    subjects: [
      { s: '0103', name: '中醫臨床醫學(一)', tag: 'tcm_clinical_1' },
      { s: '0104', name: '中醫臨床醫學(二)', tag: 'tcm_clinical_2' },
      { s: '0105', name: '中醫臨床醫學(三)', tag: 'tcm_clinical_3' },
      { s: '0106', name: '中醫臨床醫學(四)', tag: 'tcm_clinical_4' },
    ],
  },
  {
    file: 'questions-tcm2.json',
    tag: 'tcm2_111_1',
    code: '111030',
    classCode: '102',
    year: '111',
    session: '第一次',
    parser: 'column',
    subjects: [
      { s: '0103', name: '中醫臨床醫學(一)', tag: 'tcm_clinical_1' },
      { s: '0104', name: '中醫臨床醫學(二)', tag: 'tcm_clinical_2' },
      { s: '0105', name: '中醫臨床醫學(三)', tag: 'tcm_clinical_3' },
      { s: '0106', name: '中醫臨床醫學(四)', tag: 'tcm_clinical_4' },
    ],
  },
  {
    file: 'questions-tcm2.json',
    tag: 'tcm2_111_2',
    code: '111110',
    classCode: '102',
    year: '111',
    session: '第二次',
    parser: 'column',
    subjects: [
      { s: '0103', name: '中醫臨床醫學(一)', tag: 'tcm_clinical_1' },
      { s: '0104', name: '中醫臨床醫學(二)', tag: 'tcm_clinical_2' },
      { s: '0105', name: '中醫臨床醫學(三)', tag: 'tcm_clinical_3' },
      { s: '0106', name: '中醫臨床醫學(四)', tag: 'tcm_clinical_4' },
    ],
  },
  // nutrition 110-111 — c=103 (not 102 like later years); mixed essay+MCQ PDFs
  // Each subject has 40 MCQ after an essay section; expected 240/session
  ...['110030','110111','111030','111110'].map(code => {
    const year = code.slice(0, 3)
    const session = code.slice(3) === '030' ? '第一次' : '第二次'
    return {
      file: 'questions-nutrition.json',
      tag: `nutrition_${year}_${session === '第一次' ? '1' : '2'}`,
      code,
      classCode: '103',
      year,
      session,
      parser: 'column',
      subjects: [
        { s: '0201', name: '生理學與生物化學', tag: 'physio_biochem' },
        { s: '0202', name: '營養學', tag: 'nutrition_science' },
        { s: '0203', name: '膳食療養學', tag: 'diet_therapy' },
        { s: '0204', name: '團體膳食設計與管理', tag: 'group_meal' },
        { s: '0205', name: '公共衛生營養學', tag: 'public_nutrition' },
        { s: '0206', name: '食品衛生與安全', tag: 'food_safety' },
      ],
    }
  }),
  // nutrition 112 第一次 — joint exam with nursing/social worker, c=101 (NOT 102/103)
  // Pre-reform PDF format (no A/B/C/D labels) → column parser; 40 MCQ per subject after essay section
  {
    file: 'questions-nutrition.json',
    tag: 'nutrition_112_1',
    code: '112030',
    classCode: '101',
    year: '112',
    session: '第一次',
    parser: 'column',
    subjects: [
      { s: '0101', name: '生理學與生物化學', tag: 'physio_biochem' },
      { s: '0102', name: '營養學', tag: 'nutrition_science' },
      { s: '0103', name: '膳食療養學', tag: 'diet_therapy' },
      { s: '0104', name: '團體膳食設計與管理', tag: 'group_meal' },
      { s: '0105', name: '公共衛生營養學', tag: 'public_nutrition' },
      { s: '0106', name: '食品衛生與安全', tag: 'food_safety' },
    ],
  },
  // nutrition 113 第一次 — c=102, atypical 2-digit s codes (11/22/33/44/55/66)
  // Post-reform format with A./B./C./D. labels → labeled parser; essay then MCQ
  {
    file: 'questions-nutrition.json',
    tag: 'nutrition_113_1',
    code: '113030',
    classCode: '102',
    year: '113',
    session: '第一次',
    parser: 'labeled',
    subjects: [
      { s: '33', name: '生理學與生物化學', tag: 'physio_biochem' },
      { s: '44', name: '營養學', tag: 'nutrition_science' },
      { s: '11', name: '膳食療養學', tag: 'diet_therapy' },
      { s: '22', name: '團體膳食設計與管理', tag: 'group_meal' },
      { s: '55', name: '公共衛生營養學', tag: 'public_nutrition' },
      { s: '66', name: '食品衛生與安全', tag: 'food_safety' },
    ],
  },
]

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const only = args.find(a => a.startsWith('--only='))?.slice(7)

  for (const batch of BATCHES) {
    if (only && !batch.tag.startsWith(only)) continue
    console.log(`\n=== ${batch.tag} (code=${batch.code}, c=${batch.classCode}) ===`)
    const filePath = path.join(__dirname, '..', batch.file)
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const existingQs = existing.questions || []
    let nextId = (existingQs.reduce((m, q) => Math.max(m, +q.id || 0), 0)) + 1
    const existingKeys = new Set(existingQs.map(q =>
      `${q.roc_year}|${q.session}|${q.exam_code}|${q.subject_tag}|${q.number}`
    ))
    const newQs = []

    for (const sub of batch.subjects) {
      try {
        const qBuf = await cachedPdf(batch.tag, 'Q', batch.code, batch.classCode, sub.s)
        const sBuf = await cachedPdf(batch.tag, 'S', batch.code, batch.classCode, sub.s).catch(() => null)
        let mBuf = null
        try { mBuf = await cachedPdf(batch.tag, 'M', batch.code, batch.classCode, sub.s) } catch {}

        let parsed
        if (batch.parser === 'labeled') {
          const qText = (await pdfParse(qBuf)).text
          const list = parseLabeled(qText)
          parsed = {}
          for (const q of list) parsed[q.number] = { question: q.question, options: q.options }
        } else {
          parsed = await parseColumnAware(qBuf)
        }

        let answers = {}
        if (sBuf) {
          if (batch.parser === 'column') {
            answers = await parseAnswersColumnAware(sBuf)
            if (Object.keys(answers).length < 20) {
              answers = parseAnswers((await pdfParse(sBuf)).text)
            }
          } else {
            answers = parseAnswers((await pdfParse(sBuf)).text)
          }
        }
        const corrections = mBuf ? parseCorrections((await pdfParse(mBuf)).text) : {}
        for (const [num, ch] of Object.entries(corrections)) {
          if (ch !== '*') answers[num] = ch
        }

        const numKeys = Object.keys(parsed).map(n => +n).sort((a, b) => a - b)
        const ansKeys = Object.keys(answers).map(n => +n)
        const maxN = Math.max(...(ansKeys.length ? ansKeys : [80]))
        const missing = []
        for (let i = 1; i <= maxN; i++) if (!numKeys.includes(i)) missing.push(i)
        console.log(`  ${sub.s} ${sub.name}: parsed ${numKeys.length}Q, ${Object.keys(answers).length}A, ${Object.keys(corrections).length} corr${missing.length ? ' missing=' + missing.join(',') : ''}`)

        let kept = 0
        for (const num of numKeys) {
          const q = parsed[num]
          const a = answers[num]
          if (!a) continue
          if (!q.question || !q.options.A || !q.options.B || !q.options.C || !q.options.D) continue
          const dupKey = `${batch.year}|${batch.session}|${batch.code}|${sub.tag}|${num}`
          if (existingKeys.has(dupKey)) continue
          // Defensive: strip mupdf PUA markers (U+E000..U+F8FF) from all text fields.
          // The MoEX PDFs use a custom font whose A/B/C/D circled glyphs land in PUA;
          // they render as 口 boxes in the user's app font.
          const stripPUA = s => typeof s === 'string' ? s.replace(/[\uE000-\uF8FF]/g, '').trim() : s
          const cleanOpts = {}
          for (const k of ['A', 'B', 'C', 'D']) cleanOpts[k] = stripPUA(q.options[k])
          newQs.push({
            id: nextId++,
            roc_year: batch.year,
            session: batch.session,
            exam_code: batch.code,
            subject: sub.name,
            subject_tag: sub.tag,
            subject_name: sub.name,
            stage_id: 0,
            number: num,
            question: stripPUA(q.question),
            options: cleanOpts,
            answer: a,
            explanation: '',
            ...(corrections[num] === '*' ? { disputed: true } : {}),
          })
          kept++
        }
        console.log(`    kept: ${kept}`)
        await sleep(200)
      } catch (e) {
        console.log(`  ✗ ${sub.s} ${sub.name}: ${e.message}`)
      }
    }

    if (dryRun) {
      console.log(`  [dry-run] would add ${newQs.length} questions`)
      continue
    }
    if (!newQs.length) {
      console.log('  No new questions')
      continue
    }
    existing.questions = existingQs.concat(newQs)
    existing.total = existing.questions.length
    if (existing.metadata) existing.metadata.last_updated = new Date().toISOString()
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf-8')
    console.log(`  ✅ ${existingQs.length} → ${existing.questions.length} questions`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
