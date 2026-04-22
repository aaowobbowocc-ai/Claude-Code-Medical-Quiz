#!/usr/bin/env node
// Fill 24 missing doctor1 questions (16 papers missing Q100, plus a handful of
// other gaps). Uses the column-aware parser; requires answer PDFs too.

const fs = require('fs')
const path = require('path')
const https = require('https')
const { parseAnswersColumnAware, parseAnswersText } = require('./lib/moex-column-parser')

// Local patched parseColumnAware — widens anchor width filter from 22 to 34 so
// Q100 (3-digit anchor) is detected. Otherwise identical to the library version.
const stripPUA = s => s.replace(/[-]/g, '')
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
        const t = stripPUA(ln.text || '').trim()
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
      // Case 1: isolated number anchor ("20")
      const bare = ln.text.match(/^(\d{1,3})$/)
      if (bare && ln.w <= 34) {
        const num = +bare[1]
        if (num >= 1 && num <= 120 && !(isFirstPage && ln.y < 180)) {
          anchors.push({ num, y: ln.y, x: ln.x, mergedText: null })
          continue
        }
      }
      // Case 2: merged anchor ("100.下列何者...") — common for Q100 in some PDFs
      const merged = ln.text.match(/^(\d{1,3})[.、．]\s*(.+)$/)
      if (merged) {
        const num = +merged[1]
        if (num >= 1 && num <= 120 && !(isFirstPage && ln.y < 180)) {
          anchors.push({ num, y: ln.y, x: ln.x, mergedText: merged[2] })
        }
      }
    }
    const seen = new Set()
    return anchors.filter(a => { if (seen.has(a.num)) return false; seen.add(a.num); return true })
  }

  // Re-use library's extractQuestionFromContent / column histogram logic by
  // loading it; simpler: reimplement minimal version inline using an mupdf
  // per-anchor slice.
  const pageData = []
  for (let i = 0; i < n; i++) {
    const lines = parsePage(doc.loadPage(i))
    pageData.push({ lines, anchors: findAnchors(lines, i === 0) })
  }
  const isAnchorLine = ln =>
    ln.x <= 60 && (
      (ln.w <= 34 && /^\d{1,3}$/.test(ln.text)) ||
      /^\d{1,3}[.、．]\s*\S/.test(ln.text)
    )
  const isHeaderLine = ln => /^(代號|頁次|類\s*科|科\s*目|考試時間|等\s*別|本試題|座號|※\s*注意)/.test(ln.text)

  // column histogram (for splitting merged options)
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
      for (const p of r.parts) xCounts.set(p.x, (xCounts.get(p.x) || 0) + 1)
    }
  }
  const sortedX = [...xCounts.entries()].sort((a, b) => b[1] - a[1])
  const columnHistogram = []
  for (const [x] of sortedX) {
    if (columnHistogram.every(cx => Math.abs(cx - x) > 6)) columnHistogram.push(x)
    if (columnHistogram.length >= 4) break
  }
  columnHistogram.sort((a, b) => a - b)

  function extractQ(content) {
    if (!content.length) return null
    const rows = []
    for (const ln of content) {
      const last = rows[rows.length - 1]
      if (last && Math.abs(last.y - ln.y) <= 5) last.parts.push(ln)
      else rows.push({ y: ln.y, parts: [ln] })
    }
    for (const r of rows) r.parts.sort((a, b) => a.x - b.x)

    const isOptionRow = r => {
      if (r.parts.length < 2) return false
      const xs = r.parts.map(p => p.x).sort((a, b) => a - b)
      for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > 50) {
        const maxW = Math.max(...r.parts.map(p => p.w || 0))
        if (maxW < 260) return true
      }
      return false
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
    if (optionParts.length < 4) return null
    const opts = optionParts.slice(0, 4).map(p => p.text.trim())
    const question = questionRows.map(r => r.parts.map(p => p.text).join('')).join('').trim()
    if (!question) return null
    return { question, options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] } }
  }

  const out = {}
  for (let pi = 0; pi < pageData.length; pi++) {
    const { lines, anchors } = pageData[pi]
    for (let ai = 0; ai < anchors.length; ai++) {
      const a = anchors[ai]
      const nextA = ai + 1 < anchors.length ? anchors[ai + 1] : null
      let content
      if (nextA) {
        content = lines.filter(ln => !isAnchorLine(ln) && !isHeaderLine(ln) && ln.y >= a.y - 2 && ln.y < nextA.y - 2)
      } else if (pi + 1 < pageData.length) {
        const curTail = lines.filter(ln => !isAnchorLine(ln) && !isHeaderLine(ln) && ln.y >= a.y - 2)
        const np = pageData[pi + 1]
        const nextOnNext = np.anchors.length ? np.anchors[0] : null
        const nextTail = np.lines
          .filter(ln => !isAnchorLine(ln) && !isHeaderLine(ln) && (nextOnNext == null || ln.y < nextOnNext.y - 2))
          .map(ln => ({ ...ln, y: ln.y + 2000 }))
        content = curTail.concat(nextTail)
      } else {
        content = lines.filter(ln => !isAnchorLine(ln) && !isHeaderLine(ln) && ln.y >= a.y - 2)
      }
      // If merged anchor, prepend its text as a synthetic content line at the anchor's y
      if (a.mergedText) {
        content = [{ y: a.y, x: a.x + 20, w: 200, h: 12, fs: 12, text: a.mergedText }, ...content]
      }
      const q = extractQ(content)
      if (q && !out[a.num]) out[a.num] = q
    }
  }
  return out
}

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const QFILE = path.join(__dirname, '..', 'questions.json')

// Enumerated from the gap audit (roc_year, session, subject, code, c, s, missing[])
const TARGETS = [
  { yr:'100', ses:'第一次', subj:'醫學(二)', code:'100030', c:'101', s:'0102', miss:[28] },
  { yr:'101', ses:'第一次', subj:'醫學(二)', code:'101030', c:'101', s:'0102', miss:[32] },
  { yr:'101', ses:'第二次', subj:'醫學(二)', code:'101110', c:'101', s:'0102', miss:[75,98] },
  { yr:'102', ses:'第二次', subj:'醫學(一)', code:'102110', c:'101', s:'0101', miss:[87] },
  { yr:'103', ses:'第二次', subj:'醫學(一)', code:'103100', c:'101', s:'0101', miss:[70] },
  { yr:'104', ses:'第二次', subj:'醫學(一)', code:'104090', c:'301', s:'55',   miss:[100] },
  { yr:'104', ses:'第二次', subj:'醫學(二)', code:'104090', c:'301', s:'66',   miss:[100] },
  { yr:'105', ses:'第一次', subj:'醫學(一)', code:'105020', c:'301', s:'55',   miss:[100] },
  { yr:'105', ses:'第二次', subj:'醫學(一)', code:'105100', c:'301', s:'55',   miss:[100] },
  { yr:'105', ses:'第二次', subj:'醫學(二)', code:'105100', c:'301', s:'66',   miss:[100] },
  { yr:'106', ses:'第一次', subj:'醫學(二)', code:'106020', c:'301', s:'66',   miss:[100] },
  { yr:'106', ses:'第二次', subj:'醫學(一)', code:'106100', c:'301', s:'11',   miss:[100] },
  { yr:'106', ses:'第二次', subj:'醫學(二)', code:'106100', c:'301', s:'22',   miss:[100] },
  { yr:'107', ses:'第二次', subj:'醫學(一)', code:'107100', c:'301', s:'11',   miss:[100] },
  { yr:'107', ses:'第二次', subj:'醫學(二)', code:'107100', c:'301', s:'22',   miss:[100] },
  { yr:'108', ses:'第一次', subj:'醫學(一)', code:'108030', c:'301', s:'11',   miss:[100] },
  { yr:'108', ses:'第一次', subj:'醫學(二)', code:'108030', c:'301', s:'22',   miss:[100] },
  { yr:'108', ses:'第二次', subj:'醫學(一)', code:'108100', c:'301', s:'11',   miss:[100] },
  { yr:'108', ses:'第二次', subj:'醫學(二)', code:'108100', c:'301', s:'22',   miss:[100] },
  { yr:'109', ses:'第一次', subj:'醫學(一)', code:'109020', c:'301', s:'11',   miss:[100] },
  { yr:'109', ses:'第一次', subj:'醫學(二)', code:'109020', c:'301', s:'22',   miss:[100] },
  { yr:'109', ses:'第二次', subj:'醫學(一)', code:'109100', c:'301', s:'11',   miss:[100] },
  { yr:'109', ses:'第二次', subj:'醫學(二)', code:'109100', c:'301', s:'22',   miss:[100] },
]

const pdfParse = require('pdf-parse')

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode))
      const bufs = []
      res.on('data', b => bufs.push(b))
      res.on('end', () => resolve(Buffer.concat(bufs)))
    }).on('error', reject)
  })
}

const buildUrl = (t, ty) =>
  `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=${ty}&code=${t.code}&c=${t.c}&s=${t.s}&q=1`

function subjectTagFromSubject(subj, num) {
  // Rough heuristic for 113+ format; earlier years use legacy keyword classifier
  // but since these are mostly 104-109, fall back to paper default.
  return subj === '醫學(一)' ? 'anatomy' : 'pathology'
}

async function main() {
  const data = JSON.parse(fs.readFileSync(QFILE, 'utf8'))
  const arr = Array.isArray(data) ? data : data.questions

  const adds = []
  let failed = 0

  for (const t of TARGETS) {
    console.log(`\n-- ${t.yr}-${t.ses} ${t.subj} ${t.code}  miss=${t.miss.join(',')} --`)
    let buf, ansBuf
    try {
      buf = await fetch(buildUrl(t, 'Q'))
      ansBuf = await fetch(buildUrl(t, 'S'))
    } catch (e) { console.log('  fetch err:', e.message); failed++; continue }

    let parsedQ, parsedA
    try {
      parsedQ = await parseColumnAware(buf)
    } catch (e) { console.log('  parse Q err:', e.message); failed++; continue }
    try {
      parsedA = await parseAnswersColumnAware(ansBuf)
      if (Object.keys(parsedA).length === 0) {
        parsedA = parseAnswersText((await pdfParse(ansBuf)).text)
      }
    } catch (e) {
      try { parsedA = parseAnswersText((await pdfParse(ansBuf)).text) }
      catch (e2) { console.log('  parse A err:', e2.message); failed++; continue }
    }

    for (const n of t.miss) {
      const q = parsedQ[n]
      const ans = parsedA[n]
      if (!q || !ans) {
        console.log('  Q' + n + ' → missing in parse (q=' + !!q + ', a=' + !!ans + ')')
        failed++
        continue
      }
      const optsOk = ['A','B','C','D'].every(k => q.options[k] && q.options[k].trim().length >= 2)
      if (!optsOk) {
        console.log('  Q' + n + ' → options sanity failed')
        failed++
        continue
      }
      const entry = {
        id: `${t.code}_${t.s}_${n}`,
        roc_year: t.yr,
        session: t.ses,
        exam_code: t.code,
        subject: t.subj,
        subject_tag: subjectTagFromSubject(t.subj, n),
        subject_name: t.subj,
        stage_id: 0,
        number: n,
        question: q.question,
        options: { A: q.options.A, B: q.options.B, C: q.options.C, D: q.options.D },
        answer: ans,
        explanation: '',
      }
      adds.push(entry)
      console.log('  Q' + n + ' → ' + entry.question.substring(0, 40) + '... ans=' + ans)
    }
  }

  console.log(`\n=== Added ${adds.length} | Failed ${failed} ===`)
  if (process.argv.includes('--dry-run')) { console.log('(dry-run, no write)'); return }
  if (adds.length === 0) return

  const out = Array.isArray(data) ? [...arr, ...adds] : { ...data, questions: [...arr, ...adds] }
  const tmp = QFILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2))
  fs.renameSync(tmp, QFILE)
  console.log('wrote', QFILE)
}

main().catch(e => { console.error(e); process.exit(1) })
