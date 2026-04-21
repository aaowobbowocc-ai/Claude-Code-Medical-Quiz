#!/usr/bin/env node
// Probe 10 nursing missing questions by dumping lines near each anchor.
const fs = require('fs')
const path = require('path')

const CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')

const TARGETS = [
  { code: '110030', c: '104', s: '0301', subject: '基礎醫學', n: 65 },
  { code: '110110', c: '104', s: '0302', subject: '基本護理學與護理行政', n: 22 },
  { code: '110110', c: '104', s: '0303', subject: '內外科護理學', n: 51 },
  { code: '110110', c: '104', s: '0305', subject: '精神科與社區衛生護理學', n: 34 },
  { code: '112110', c: '102', s: '0201', subject: '基礎醫學', n: 25 },
  { code: '114100', c: '102', s: '0201', subject: '基礎醫學', n: 8 },
  { code: '114100', c: '102', s: '0202', subject: '基本護理學與護理行政', n: 3 },
  { code: '114100', c: '102', s: '0203', subject: '內外科護理學', n: 40 },
  { code: '114100', c: '102', s: '0204', subject: '產兒科護理學', n: 43 },
  { code: '114100', c: '102', s: '0205', subject: '精神科與社區衛生護理學', n: 19 },
]

async function pdfLines(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const nPages = doc.countPages()
  const lines = []
  for (let pi = 0; pi < nPages; pi++) {
    const pg = doc.loadPage(pi)
    const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
    for (const b of parsed.blocks || []) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const t = (ln.text || '').trim()
        if (!t) continue
        lines.push({
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
  lines.sort((a, b) => a.y - b.y || a.x - b.x)
  return lines
}

;(async () => {
  for (const t of TARGETS) {
    const file = path.join(CACHE, `nursing_Q_${t.code}_c${t.c}_s${t.s}.pdf`)
    if (!fs.existsSync(file)) { console.log('SKIP:', file); continue }
    const buf = fs.readFileSync(file)
    const lines = await pdfLines(buf)
    const n = t.n

    // Find anchor: line at low x (≤ 80) whose text starts with the target number
    const candidates = []
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]
      if (ln.x > 80) continue
      const tx = ln.text.trim()
      // Match: bare "N", "N.", "N．", "N、", or "N<space>text" at start
      if (tx === String(n)) candidates.push({ idx: i, kind: 'bare' })
      else {
        const m = tx.match(/^(\d{1,3})\s*[.．、]?\s*(.*)$/)
        if (m && parseInt(m[1]) === n) candidates.push({ idx: i, kind: 'prefix' })
      }
    }
    if (candidates.length === 0) {
      console.log(`\n=== ${t.code}/${t.subject} #${n} — NO CANDIDATES ===`)
      // Debug dump: show low-x numeric lines
      const lowx = lines.filter(l => l.x <= 80 && /^\d/.test(l.text.trim())).slice(0, 30)
      for (const l of lowx) console.log(`  p${l.pi} y${l.ly} x${l.x}: ${l.text.slice(0, 60)}`)
      continue
    }

    // Prefer the candidate whose previous anchor was n-1 (most reliable)
    let anchorIdx = candidates[candidates.length - 1].idx
    for (const cand of candidates) {
      // Look back up to 100 lines to see if any recent low-x number is n-1
      for (let j = cand.idx - 1; j >= Math.max(0, cand.idx - 100); j--) {
        const ln = lines[j]
        if (ln.x > 80) continue
        const m = ln.text.trim().match(/^(\d{1,3})/)
        if (m) {
          if (parseInt(m[1]) === n - 1) { anchorIdx = cand.idx; break }
          else break
        }
      }
    }

    // Collect lines from anchor to next anchor (n+1) — or 150 lines max
    let endIdx = Math.min(lines.length, anchorIdx + 150)
    for (let i = anchorIdx + 1; i < lines.length && i < anchorIdx + 150; i++) {
      const ln = lines[i]
      if (ln.x > 80) continue
      const tx = ln.text.trim()
      const m = tx.match(/^(\d{1,3})/)
      if (m && parseInt(m[1]) === n + 1) { endIdx = i; break }
    }

    console.log(`\n=== ${t.code}/${t.subject} #${n} [anchor idx=${anchorIdx}, end=${endIdx}] ===`)
    for (let i = anchorIdx; i < endIdx; i++) {
      const ln = lines[i]
      console.log(`p${ln.pi} y${ln.ly} x${ln.x}: ${ln.text}`)
    }
  }
})().catch(e => { console.error(e); process.exit(1) })
