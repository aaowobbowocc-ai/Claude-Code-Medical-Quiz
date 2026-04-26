#!/usr/bin/env node
/**
 * One-shot scraper for nursing/nutrition missing years.
 *
 * Covers old sessions where the class code / session code scheme differs
 * from the 030 series handled by scrape-moex.js:
 *   - nursing 110030/110110/111030 used c=104 (before 114030 switched to c=101)
 *   - nursing 112110/114100 (第二次 sessions) used c=102
 *   - nutrition 114100 used c=101
 *
 * Electronic system only has 基礎醫學 + 基本護理學 for most old nursing years,
 * and a 6-paper set for nutrition 114100 — but paper3-5 may be empty for old
 * years. Script probes all configured subjects and skips any that don't exist.
 *
 * Old nursing PDFs (104 series) use a non-standard layout without "X." prefixes:
 *   - Question number is a bare digit at x≈41-52, question text at x≈58-69
 *   - Options have no A/B/C/D markers — assigned by reading order across
 *     columns at x≈58/187/307/427 (4-col) or x≈58/307 (2-col) or x≈58 (1-col)
 *
 * Answer PDFs use a table format:
 *   - "第N題" label spans then "A/B/C/D" letter spans below, matched by x-col
 */

const fs = require('fs')
const path = require('path')
const { fetchPdf, cachedFetch, buildMoexUrl } = require('./lib/pdf-fetcher')
const https = require('https')

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')
fs.mkdirSync(CACHE, { recursive: true })

// ─── HTTP ───

async function cachedPdf(tag, t, code, c, s) {
  const key = `${tag}_${t}_${code}_c${c}_s${s}.pdf`
  const p = path.join(CACHE, key)
  if (fs.existsSync(p) && fs.statSync(p).size > 1000) return fs.readFileSync(p)
  const url = `${BASE}?t=${t}&code=${code}&c=${c}&s=${s}&q=1`
  try {
    const buf = await fetchPdf(url)
    if (buf.length > 1000) fs.writeFileSync(p, buf)
    return buf
  } catch { return null }
}

// ─── Unified span extraction ───
// Returns array of {pi, y (global), ly (local), x, w, text} sorted by global y then x.
async function pdfSpans(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const n = doc.countPages()
  const spans = []
  for (let pi = 0; pi < n; pi++) {
    const pg = doc.loadPage(pi)
    const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
    for (const b of parsed.blocks) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const t = (ln.text || '').trim()
        if (!t) continue
        spans.push({
          pi,
          y: pi * 10000 + Math.round(ln.bbox.y),
          ly: Math.round(ln.bbox.y),
          x: Math.round(ln.bbox.x),
          w: Math.round(ln.bbox.w || 0),
          text: ln.text,
        })
      }
    }
    try { pg.destroy?.() } catch {}
  }
  try { doc.destroy?.() } catch {}
  spans.sort((a, b) => a.y - b.y || a.x - b.x)
  return spans
}

// ─── Question parser (layout-aware) ───
// Nursing 104/102 PDFs: question number is a bare digit span at x<55,
// question text follows on same/close y at x≈58-69, options come after.
function parseQuestionsLayout(spans) {
  // Filter header/footer lines that repeat every page (page number, header text, etc.)
  // Heuristic: drop known header patterns
  const headerPatterns = [
    /^類科/, /^科目/, /^等別/, /^考試時間/, /^座號/, /^※注意/, /^本科目共/, /^禁止使用/,
    /^頁次/, /^代號：/, /年第[一二]次/, /年專門職業/,
  ]
  const clean = spans.filter(s => !headerPatterns.some(r => r.test(s.text)))

  // Find question anchors: span text is a bare 1-3 digit number at x<55
  const anchors = []
  for (let i = 0; i < clean.length; i++) {
    const s = clean[i]
    if (s.x <= 55 && /^\d{1,3}$/.test(s.text.trim())) {
      const n = parseInt(s.text.trim())
      if (n >= 1 && n <= 120) anchors.push({ idx: i, n, y: s.y, x: s.x })
    }
  }
  // Dedupe by number (keep first occurrence of each anchor num on a page)
  const seen = new Set()
  const out = []
  let lastSuccessNum = 0
  for (let ai = 0; ai < anchors.length; ai++) {
    const a = anchors[ai]
    const nextA = anchors[ai + 1]
    const rangeEnd = nextA ? nextA.idx : clean.length
    // Skip obvious false anchors: num must be strictly increasing across the
    // whole document (so we never mistake a stray "2" inside question text as
    // a new anchor). Don't cascade-reject on parse failures below.
    if (a.n <= lastSuccessNum) continue
    if (seen.has(a.n)) continue
    seen.add(a.n)
    lastSuccessNum = Math.max(lastSuccessNum, a.n)

    const body = []
    for (let j = a.idx + 1; j < rangeEnd; j++) {
      const s = clean[j]
      // Skip if in another anchor column (another bare digit at x<55 in same range — shouldn't happen)
      if (s.x <= 55 && /^\d{1,3}$/.test(s.text.trim())) continue
      body.push(s)
    }

    // Group body into y rows (Δy ≤ 3 within same page)
    const rows = []
    for (const s of body) {
      const last = rows[rows.length - 1]
      if (last && last.pi === s.pi && Math.abs(last.y - s.y) <= 3) last.items.push(s)
      else rows.push({ pi: s.pi, y: s.y, items: [s] })
    }
    for (const r of rows) r.items.sort((a, b) => a.x - b.x)

    if (rows.length === 0) continue

    // Walk rows backward, accumulate until we have exactly 4 items, each row intact
    const optItems = []
    let splitIdx = rows.length
    for (let ri = rows.length - 1; ri >= 0; ri--) {
      const count = rows[ri].items.length
      if (optItems.length + count > 4) break
      // Prepend row's items in reading order
      optItems.unshift(...rows[ri].items)
      splitIdx = ri
      if (optItems.length === 4) break
    }

    if (optItems.length !== 4) continue // can't cleanly parse — skip

    const qRows = rows.slice(0, splitIdx)
    // Question text = concatenate all items in q rows in reading order
    const qText = qRows.map(r => r.items.map(it => it.text).join('')).join('')
    if (!qText.trim()) continue

    out.push({
      num: a.n,
      question: qText.trim(),
      options: {
        A: optItems[0].text.trim(),
        B: optItems[1].text.trim(),
        C: optItems[2].text.trim(),
        D: optItems[3].text.trim(),
      },
    })
  }
  return out
}

// ─── Prefix-based parser (for PDFs with "1." prefix format) ───
// Handles nutrition 114100 and similar newer-format PDFs. Skips any
// 申論題 section by looking for the 測驗題 / 選擇題 marker.
function pageTextColumnAware(spans, pi) {
  const pageSpans = spans.filter(s => s.pi === pi)
  // Group by ly with Δ ≤ 3
  const groups = []
  for (const s of pageSpans) {
    const last = groups[groups.length - 1]
    if (last && Math.abs(last.ly - s.ly) <= 3) last.parts.push(s)
    else groups.push({ ly: s.ly, parts: [s] })
  }
  return groups.map(g => {
    g.parts.sort((a, b) => a.x - b.x)
    let merged = ''
    for (const p of g.parts) {
      const t = p.text
      if (merged && t) {
        const mTrim = merged.replace(/\s+$/, '')
        const tTrim = t.replace(/^\s+/, '')
        const lastCh = mTrim[mTrim.length - 1]
        const firstCh = tTrim[0]
        if (lastCh && lastCh === firstCh && !/\s/.test(lastCh)) {
          merged = mTrim + tTrim.slice(1)
        } else {
          merged += t
        }
      } else merged += t
    }
    return merged.trim()
  }).join('\n')
}

function parseQuestionsPrefix(spans) {
  const pages = new Set(spans.map(s => s.pi))
  let fullText = ''
  for (const pi of [...pages].sort((a, b) => a - b)) {
    fullText += pageTextColumnAware(spans, pi) + '\n'
  }
  const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean)
  const out = []
  let cur = null, curOpt = null, qBuf = [], optBuf = ''
  let pendingNum = null
  let inMc = false
  function flushOpt() {
    if (cur && curOpt) cur.options[curOpt] = optBuf.trim()
    optBuf = ''; curOpt = null
  }
  function flushQ() {
    flushOpt()
    if (cur && Object.keys(cur.options).length >= 2) {
      cur.question = qBuf.join('').trim()
      if (cur.question) out.push(cur)
    }
    cur = null; qBuf = []
  }
  function tryStartQuestion(n, after) {
    const isSeq = !cur ? (n === 1 || out.length === 0) : n === cur.num + 1
    if (n >= 1 && n <= 120 && after && after.length >= 2 && isSeq) {
      flushQ()
      cur = { num: n, question: '', options: {} }
      qBuf = [after]
      return true
    }
    return false
  }
  for (const ln of lines) {
    // Detect MC section marker — drop any essay-section state
    if (/二、?\s*測驗題|測驗式試題|選擇題/.test(ln) && !inMc) {
      inMc = true
      cur = null; curOpt = null; qBuf = []; optBuf = ''
      continue
    }
    // If there's no explicit essay section, assume MC-only and inMc from start
    // (triggered when we see question 1)
    if (!inMc && /^1[.．、]/.test(ln)) inMc = true
    if (!inMc) continue

    const mBare = ln.match(/^(\d{1,3})[.．、]\s*$/)
    if (mBare) {
      const n = +mBare[1]
      if (n >= 1 && n <= 120) { pendingNum = n; continue }
    }
    if (pendingNum != null) {
      const n = pendingNum; pendingNum = null
      if (!/^[A-D][.．]/.test(ln)) {
        if (tryStartQuestion(n, ln)) continue
      }
    }
    const mQ = ln.match(/^(\d{1,3})[.．、]\s*(.*)/)
    if (mQ) {
      if (tryStartQuestion(+mQ[1], mQ[2])) continue
    }
    const mOpt = ln.match(/^([A-D])[.．]\s*(.*)/)
    if (mOpt && cur) {
      flushOpt()
      curOpt = mOpt[1]
      optBuf = mOpt[2]
      continue
    }
    if (curOpt) optBuf += ln
    else if (cur) qBuf.push(ln)
  }
  flushQ()
  return out
}

// ─── Flat-text answer parser ───
// For answer PDFs that just list full-width ＡＢＣＤ letters in reading order
// (one per line, potentially grouped into 20-question columns). Counts total
// letters and assigns to questions 1..N in order.
function parseAnswersFlat(spans) {
  // Sort spans in reading order (page, y, x) — already sorted
  const letters = []
  for (const s of spans) {
    for (const ch of s.text) {
      if (ch === 'Ａ') letters.push('A')
      else if (ch === 'Ｂ') letters.push('B')
      else if (ch === 'Ｃ') letters.push('C')
      else if (ch === 'Ｄ') letters.push('D')
    }
  }
  // Half-width fallback: if no full-width, try A/B/C/D single-char spans
  if (letters.length < 5) {
    for (const s of spans) {
      const t = s.text.trim()
      if (/^[A-D]$/.test(t)) letters.push(t)
    }
  }
  const out = {}
  letters.forEach((a, i) => { out[i + 1] = a })
  return out
}

// ─── Answer parser (layout-aware) ───
// Answer PDF has "第N題" label spans and A/B/C/D letter spans below,
// matched by x-column (letter span x within ~20 of label span x).
function parseAnswersLayout(spans) {
  const labels = spans.filter(s => /^第(\d{1,3})題$/.test(s.text.trim()))
  const letters = spans.filter(s => /^[A-D]$/.test(s.text.trim()))
  const out = {}
  for (const lbl of labels) {
    const n = parseInt(lbl.text.match(/\d+/)[0])
    // Find closest letter that's below this label (y > lbl.y, same page), within ~30 y and ~20 x
    let best = null, bestDy = Infinity
    for (const lt of letters) {
      if (lt.pi !== lbl.pi) continue
      const dy = lt.y - lbl.y
      if (dy <= 0 || dy > 40) continue
      const dx = Math.abs(lt.x - lbl.x)
      if (dx > 25) continue
      if (dy < bestDy) { bestDy = dy; best = lt }
    }
    if (best) out[n] = best.text.trim()
  }
  return out
}

// ─── Corrections parser ───
// M PDF has a 備註 section describing corrections in plain text, e.g.:
//   第65題答Ａ給分。
//   第30題一律給分。
//   第42題答案更正為Ｃ。
// We handle full-width and half-width letters, and treat "答X給分" + "一律給分"
// + "送分" as disputed (*), "更正為X" as a real answer change.
function parseCorrectionsLayout(spans) {
  const text = spans.map(s => s.text).join('\n')
  const out = {}
  const fwToHw = ch => ch === 'Ａ' ? 'A' : ch === 'Ｂ' ? 'B' : ch === 'Ｃ' ? 'C' : ch === 'Ｄ' ? 'D' : ch.toUpperCase()
  // Match all 第N題 phrases and the nearby text
  const re = /第\s*(\d{1,3})\s*題[^第。\n]*/g
  let m
  while ((m = re.exec(text)) !== null) {
    const n = +m[1]
    const phrase = m[0]
    if (/更正.*?為?\s*([ＡＢＣＤA-D])/.test(phrase)) {
      const mm = phrase.match(/更正.*?為?\s*([ＡＢＣＤA-D])/)
      out[n] = fwToHw(mm[1])
    } else if (/一律給分|送分|答\s*[ＡＢＣＤA-D].*?給分/.test(phrase)) {
      out[n] = '*'
    }
  }
  // Also try table format: rows of "第N題 <orig> <new>"
  // Scan spans directly
  const labels = spans.filter(s => /^第(\d{1,3})題$/.test(s.text.trim()))
  for (const lbl of labels) {
    const n = parseInt(lbl.text.match(/\d+/)[0])
    // Find letters to the right of lbl (x > lbl.x + 20, same y ± 3)
    const right = spans.filter(s =>
      s.pi === lbl.pi &&
      Math.abs(s.y - lbl.y) <= 5 &&
      s.x > lbl.x + 20 &&
      /^[A-D*]$/.test(s.text.trim())
    ).sort((a, b) => a.x - b.x)
    if (right.length >= 2) {
      // original + correction; take correction (last one)
      const last = right[right.length - 1].text.trim()
      if (/^[A-D]$/.test(last)) out[n] = last
      else if (last === '*') out[n] = '*'
    } else if (right.length === 1) {
      const v = right[0].text.trim()
      if (v === '*') out[n] = '*'
      else if (/^[A-D]$/.test(v)) out[n] = v
    }
    // Check for 送分 text near label
    const near = spans.filter(s =>
      s.pi === lbl.pi &&
      Math.abs(s.y - lbl.y) <= 5 &&
      s.x > lbl.x
    )
    if (near.some(s => /送分|一律給分/.test(s.text))) out[n] = '*'
  }
  return out
}

// ─── Scrape manifest ──
const MANIFEST = [
  { exam: 'nursing', year: '110', session: '第一次', code: '110030', c: '104',
    papers: [
      { s: '0301', subject: '基礎醫學', tag: 'basic_medicine' },
      { s: '0302', subject: '基本護理學與護理行政', tag: 'basic_nursing' },
      { s: '0303', subject: '內外科護理學', tag: 'med_surg' },
      { s: '0304', subject: '產兒科護理學', tag: 'obs_ped' },
      { s: '0305', subject: '精神科與社區衛生護理學', tag: 'psych_community' },
    ] },
  { exam: 'nursing', year: '110', session: '第二次', code: '110110', c: '104',
    papers: [
      { s: '0301', subject: '基礎醫學', tag: 'basic_medicine' },
      { s: '0302', subject: '基本護理學與護理行政', tag: 'basic_nursing' },
      { s: '0303', subject: '內外科護理學', tag: 'med_surg' },
      { s: '0304', subject: '產兒科護理學', tag: 'obs_ped' },
      { s: '0305', subject: '精神科與社區衛生護理學', tag: 'psych_community' },
    ] },
  { exam: 'nursing', year: '111', session: '第一次', code: '111030', c: '104',
    papers: [
      { s: '0301', subject: '基礎醫學', tag: 'basic_medicine' },
      { s: '0302', subject: '基本護理學與護理行政', tag: 'basic_nursing' },
      { s: '0303', subject: '內外科護理學', tag: 'med_surg' },
      { s: '0304', subject: '產兒科護理學', tag: 'obs_ped' },
      { s: '0305', subject: '精神科與社區衛生護理學', tag: 'psych_community' },
    ] },
  { exam: 'nursing', year: '112', session: '第二次', code: '112110', c: '102',
    papers: [
      { s: '0201', subject: '基礎醫學', tag: 'basic_medicine' },
      { s: '0202', subject: '基本護理學與護理行政', tag: 'basic_nursing' },
      { s: '0203', subject: '內外科護理學', tag: 'med_surg' },
      { s: '0204', subject: '產兒科護理學', tag: 'obs_ped' },
      { s: '0205', subject: '精神科與社區衛生護理學', tag: 'psych_community' },
    ] },
  { exam: 'nursing', year: '114', session: '第二次', code: '114100', c: '102',
    papers: [
      { s: '0201', subject: '基礎醫學', tag: 'basic_medicine' },
      { s: '0202', subject: '基本護理學與護理行政', tag: 'basic_nursing' },
      { s: '0203', subject: '內外科護理學', tag: 'med_surg' },
      { s: '0204', subject: '產兒科護理學', tag: 'obs_ped' },
      { s: '0205', subject: '精神科與社區衛生護理學', tag: 'psych_community' },
    ] },
  { exam: 'nutrition', year: '114', session: '第二次', code: '114100', c: '101',
    papers: [
      { s: '0101', subject: '膳食療養學', tag: 'diet_therapy' },
      { s: '0102', subject: '團體膳食設計與管理', tag: 'group_meal' },
      { s: '0103', subject: '生理學與生物化學', tag: 'physio_biochem' },
      { s: '0104', subject: '營養學', tag: 'nutrition_science' },
      { s: '0105', subject: '公共衛生營養學', tag: 'public_nutrition' },
      { s: '0106', subject: '食品衛生與安全', tag: 'food_safety' },
    ] },
]

async function processPaper(entry, p) {
  const qBuf = await cachedPdf(entry.exam, 'Q', entry.code, entry.c, p.s)
  if (!qBuf || qBuf.length < 2000) return { skip: 'no Q PDF', qs: [], ans: {}, corr: {} }

  const qSpans = await pdfSpans(qBuf)
  // Sanity: header label match
  const headText = qSpans.slice(0, 20).map(s => s.text).join(' ')
  const expectedLabel = entry.exam === 'nursing' ? '護理師' : '營養師'
  if (!headText.includes(expectedLabel)) return { skip: `header missing ${expectedLabel}`, qs: [], ans: {}, corr: {} }

  // Try both parsers; use whichever yields more questions.
  const layoutQs = parseQuestionsLayout(qSpans)
  const prefixQs = parseQuestionsPrefix(qSpans)
  const qs = prefixQs.length > layoutQs.length ? prefixQs : layoutQs

  const sBuf = await cachedPdf(entry.exam, 'S', entry.code, entry.c, p.s)
  let ans = {}
  if (sBuf && sBuf.length > 500) {
    const sSpans = await pdfSpans(sBuf)
    // Try layout-aware first (第N題 table format), fall back to flat-text if
    // it finds too few (newer format with full-width letters in columns).
    const layoutAns = parseAnswersLayout(sSpans)
    if (Object.keys(layoutAns).length >= 20) {
      ans = layoutAns
    } else {
      const flatAns = parseAnswersFlat(sSpans)
      ans = Object.keys(flatAns).length > Object.keys(layoutAns).length ? flatAns : layoutAns
    }
  }

  let corr = {}
  const mBuf = await cachedPdf(entry.exam, 'M', entry.code, entry.c, p.s)
  if (mBuf && mBuf.length > 500) {
    const mSpans = await pdfSpans(mBuf)
    corr = parseCorrectionsLayout(mSpans)
  }

  return { qs, ans, corr }
}

async function processEntry(entry) {
  const collected = []
  for (const p of entry.papers) {
    try {
      const { skip, qs, ans, corr } = await processPaper(entry, p)
      if (skip) {
        console.log(`  × ${entry.code} s=${p.s} ${p.subject}: ${skip}`)
        continue
      }
      const correctionCount = Object.keys(corr).length
      console.log(`  ✓ ${entry.code} s=${p.s} ${p.subject}: ${qs.length} questions, ${Object.keys(ans).length} answers${correctionCount ? ', ' + correctionCount + ' corrections' : ''}`)
      for (const q of qs) {
        const origAns = ans[q.num]
        if (!origAns) continue
        const correction = corr[q.num]
        let finalAns = origAns
        let disputed = undefined
        if (correction === '*') disputed = true
        else if (correction) finalAns = correction
        collected.push({
          id: `${entry.code}_${p.s}_${q.num}`,
          roc_year: entry.year,
          session: entry.session,
          exam_code: entry.code,
          subject: p.subject,
          subject_tag: p.tag,
          subject_name: p.subject,
          stage_id: 0,
          number: q.num,
          question: q.question,
          options: q.options,
          answer: finalAns,
          explanation: '',
          ...(disputed ? { disputed: true } : {}),
        })
      }
    } catch (e) {
      console.log(`  ⚠ ${entry.code} s=${p.s}: ${e.message}`)
    }
  }
  return collected
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const filterExam = args.find(a => a.startsWith('--exam='))?.slice(7)

  const collected = { nursing: [], nutrition: [] }
  for (const entry of MANIFEST) {
    if (filterExam && entry.exam !== filterExam) continue
    console.log(`\n=== ${entry.exam} ${entry.code} (${entry.year}${entry.session}) c=${entry.c} ===`)
    try {
      const list = await processEntry(entry)
      collected[entry.exam].push(...list)
    } catch (e) {
      console.error('  error:', e.message)
    }
  }

  console.log(`\nTotals: nursing=${collected.nursing.length}, nutrition=${collected.nutrition.length}`)

  if (dryRun) { console.log('(dry run — no files written)'); return }

  for (const exam of ['nursing', 'nutrition']) {
    if (!collected[exam].length) continue
    const file = path.join(__dirname, '..', `questions-${exam}.json`)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const arr = Array.isArray(raw) ? raw : raw.questions
    const newIds = new Set(collected[exam].map(q => q.id))
    const kept = arr.filter(q => !newIds.has(q.id))
    const merged = [...kept, ...collected[exam]]
    merged.sort((a, b) => {
      if (a.exam_code !== b.exam_code) return a.exam_code.localeCompare(b.exam_code)
      if (a.subject !== b.subject) return a.subject.localeCompare(b.subject)
      return (a.number || 0) - (b.number || 0)
    })
    if (Array.isArray(raw)) {
      fs.writeFileSync(file, JSON.stringify(merged, null, 2))
    } else {
      raw.questions = merged
      raw.total = merged.length
      fs.writeFileSync(file, JSON.stringify(raw, null, 2))
    }
    console.log(`✅ ${exam}: wrote ${merged.length} total (+${collected[exam].length} new)`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
