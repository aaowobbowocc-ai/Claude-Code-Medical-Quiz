#!/usr/bin/env node
// Bulk-repair truncated stems across all question files by re-extracting from
// cached PDFs. Matches on (exam_code + number). Only touches stems that look
// truncated (end with an open paren or a hanging ASCII word).
const fs = require('fs')
const path = require('path')

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')

const EXAM_PREFIX = {
  'questions.json': 'doctor1',
  'questions-doctor2.json': 'doctor2',
  'questions-dental1.json': 'dental1',
  'questions-dental2.json': 'dental2',
  'questions-pharma1.json': 'pharma1',
  'questions-pharma2.json': 'pharma2',
  'questions-medlab.json': 'medlab',
  'questions-nursing.json': 'nursing',
  'questions-nutrition.json': 'nutrition',
  'questions-pt.json': 'pt',
  'questions-ot.json': 'ot',
  'questions-vet.json': 'vet',
  'questions-tcm1.json': 'tcm1',
  'questions-tcm2.json': 'tcm2',
}

// Heuristic: looks truncated if it ends mid-parenthetical with ASCII/CJK letters
function isTruncated(stem) {
  const s = (stem || '').trim()
  if (!s) return false
  if (/[（(][a-zA-Z\u4e00-\u9fff]{0,8}$/.test(s)) return true
  // Ends mid-question-construct: "下列敘述何", "下列敘述何者", "何者", "為何"
  // but NO trailing "?" or "？" or sentence-final punct
  if (/(下列敘述何者?|[何何]者|為何)$/.test(s)) return true
  return false
}

async function pageLines(pg) {
  const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
  const out = []
  for (const b of parsed.blocks || []) {
    if (b.type !== 'text') continue
    for (const ln of (b.lines || [])) {
      const t = ln.text || ''
      if (!t.trim()) continue
      out.push({ y: Math.round(ln.bbox.y * 10) / 10, x: Math.round(ln.bbox.x * 10) / 10, text: t })
    }
  }
  // Two-column aware: split at x=300, sort each by y then x, group by y (±3)
  const mid = 300
  const cols = [out.filter(l => l.x < mid), out.filter(l => l.x >= mid)]
  const joined = []
  for (const col of cols) {
    col.sort((a, b) => a.y - b.y || a.x - b.x)
    const groups = []
    for (const ln of col) {
      const last = groups[groups.length - 1]
      if (last && Math.abs(last.y - ln.y) <= 3) last.parts.push(ln)
      else groups.push({ y: ln.y, parts: [ln] })
    }
    for (const g of groups) joined.push(g.parts.sort((a, b) => a.x - b.x).map(p => p.text).join(''))
  }
  return joined
}

async function pdfLines(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let lines = []
  for (let i = 0; i < doc.countPages(); i++) {
    lines = lines.concat(await pageLines(doc.loadPage(i)))
  }
  return lines
}

function extractStem(lines, N) {
  const startRe = new RegExp(`^${N}[.．、]\\s*(.*)$`)
  const nextRe = new RegExp(`^${N + 1}[.．、]\\s*`)
  let i = 0
  while (i < lines.length && !startRe.test(lines[i])) i++
  if (i >= lines.length) return null
  const first = lines[i].replace(startRe, '$1')
  const buf = first ? [first] : []
  i++
  for (; i < lines.length; i++) {
    const ln = lines[i].trim()
    if (!ln) continue
    if (nextRe.test(ln)) break
    if (/^\(?([A-D])\)?[.．、)]\s*/.test(ln)) break
    if (/^座號|^准考證|^代號|^頁次/.test(ln)) continue
    buf.push(ln)
  }
  const stem = buf.join('').replace(/\s+$/, '').trim()
  return stem.length >= 8 ? stem : null
}

function findCachedPdfs(prefix, code) {
  try {
    return fs.readdirSync(PDF_CACHE)
      .filter(f => f.startsWith(`${prefix}_${code}_`) && f.endsWith('.pdf'))
      .filter(f => fs.statSync(path.join(PDF_CACHE, f)).size > 10000)
      .map(f => path.join(PDF_CACHE, f))
  } catch { return [] }
}

;(async () => {
  const files = Object.keys(EXAM_PREFIX)
  let totalFixed = 0, totalTried = 0
  for (const f of files) {
    const fp = path.join(BACKEND, f)
    if (!fs.existsSync(fp)) continue
    const db = JSON.parse(fs.readFileSync(fp, 'utf8'))
    const qs = db.questions || db
    const targets = qs.filter(q => isTruncated(q.question))
    if (!targets.length) continue
    const prefix = EXAM_PREFIX[f]
    let fileFixed = 0
    for (const q of targets) {
      totalTried++
      const pdfs = findCachedPdfs(prefix, q.exam_code)
      if (!pdfs.length) { console.log(`  ${f} ${q.id}: no cached PDFs for ${q.exam_code}`); continue }
      // Verify match: extracted stem must start with or contain the same
      // ASCII/CJK head of the current truncated stem. We take the longest
      // non-whitespace prefix (>= 8 chars) from the current stem and require
      // the candidate to contain it verbatim. Otherwise we're extracting the
      // wrong question from the wrong subject PDF.
      const cur = (q.question || '').trim()
      // Use the first 10 chars of the truncated stem as the anchor, but skip
      // leading punctuation/list markers. For stems like "ond lumbricals) ③…"
      // that start mid-word (i.e., scraper dropped the very start), fall back
      // to searching for a longer 15-char chunk from the middle.
      const headRe = /^[\s　]*(.{10,20}?)(?:[（(]|，|,|。|\?)/
      let anchor = null
      const h = cur.match(headRe)
      if (h) anchor = h[1].trim()
      if (!anchor || anchor.length < 6) anchor = cur.slice(0, 12).trim()
      let best = null
      for (const p of pdfs) {
        try {
          const buf = fs.readFileSync(p)
          const lines = await pdfLines(buf)
          const stem = extractStem(lines, q.number)
          if (!stem) continue
          if (anchor && !stem.includes(anchor)) continue
          if (stem.length > (best?.length || 0)) best = stem
        } catch { }
      }
      if (!best) { console.log(`  ${f} ${q.id} #${q.number}: no PDF match (anchor="${anchor}")`); continue }
      if (best === q.question) { console.log(`  ${f} ${q.id}: identical, skip`); continue }
      if (best.length < (q.question || '').length) { console.log(`  ${f} ${q.id}: shorter, skip`); continue }
      console.log(`  ✓ ${f} ${q.id} #${q.number}`)
      console.log(`    before: ${(q.question || '').slice(-60)}`)
      console.log(`    after : ${best.slice(-80)}`)
      q.question = best
      fileFixed++
      totalFixed++
    }
    if (fileFixed) {
      if (db.metadata) db.metadata.last_updated = new Date().toISOString()
      fs.writeFileSync(fp, JSON.stringify(db, null, 2))
    }
  }
  console.log(`\nTotal: ${totalFixed} fixed / ${totalTried} tried`)
})().catch(e => { console.error(e); process.exit(1) })
