#!/usr/bin/env node
// Targeted fix for the 9 residual empty-option questions left after the
// blank-options image extraction pass. For each (file, id), probe all cached
// PDFs for the matching exam_code, find the question by number using a
// column-aware bbox parser, and rewrite question + options if a clean parse
// was obtained.

const fs = require('fs')
const path = require('path')

const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')

const TARGETS = [
  { file: 'questions.json',          id: '112100_1_66', examPrefix: 'doctor1', code: '112100', n: 66 },
  { file: 'questions-dental2.json',  id: '114090_2_56', examPrefix: 'dental2', code: '114090', n: 56 },
  { file: 'questions-pharma1.json',  id: 115020383,     examPrefix: 'pharma1', code: '110101', n: 23 },
  { file: 'questions-nutrition.json',id: 400,           examPrefix: 'nutrition', code: '115030', n: 50 },
  { file: 'questions-pt.json',       id: 233,           examPrefix: 'pt', code: '114020', n: 75 },
  { file: 'questions-pt.json',       id: 1178,          examPrefix: 'pt', code: '114090', n: 60 },
  { file: 'questions-pt.json',       id: 5122,          examPrefix: 'pt', code: '113090', n: 4 },
  { file: 'questions-vet.json',      id: 648,           examPrefix: 'vet', code: '111100', n: 8 },
  { file: 'questions-vet.json',      id: 1818,          examPrefix: 'vet', code: '113090', n: 58 },
]

function findCachedPdfs(examPrefix, code) {
  return fs.readdirSync(PDF_CACHE)
    .filter(f => f.startsWith(`${examPrefix}_${code}_`) && f.endsWith('.pdf'))
    .filter(f => fs.statSync(path.join(PDF_CACHE, f)).size > 50000)
    .map(f => path.join(PDF_CACHE, f))
}

async function pageColumnText(pg) {
  const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
  const lines = []
  for (const b of parsed.blocks || []) {
    if (b.type !== 'text') continue
    for (const ln of (b.lines || [])) {
      const t = ln.text || ''
      if (!t.trim()) continue
      lines.push({ y: Math.round(ln.bbox.y * 10) / 10, x: Math.round(ln.bbox.x * 10) / 10, text: t })
    }
  }
  // Column detection: find a vertical gap around mid-page (≈300 in PDF points)
  const mid = 300
  const left = lines.filter(l => l.x < mid)
  const right = lines.filter(l => l.x >= mid)
  const sortCol = arr => arr.sort((a, b) => a.y - b.y || a.x - b.x)
  function group(arr) {
    const groups = []
    for (const ln of arr) {
      const last = groups[groups.length - 1]
      if (last && Math.abs(last.y - ln.y) <= 3) last.parts.push(ln)
      else groups.push({ y: ln.y, parts: [ln] })
    }
    return groups.map(g => g.parts.sort((a, b) => a.x - b.x).map(p => p.text).join(''))
  }
  return [...group(sortCol(left)), ...group(sortCol(right))].join('\n')
}

async function fullPdfText(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) {
    txt += await pageColumnText(doc.loadPage(i)) + '\n'
  }
  return txt
}

// Extract question N's stem and 4 options from raw text.
function extractQA(text, N) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  let i = 0
  const startRe = new RegExp(`^${N}[.．、]\\s*(.*)$`)
  const nextRe = new RegExp(`^${N + 1}[.．、]\\s*`)
  // Find start
  while (i < lines.length && !startRe.test(lines[i])) i++
  if (i >= lines.length) return null
  const buf = []
  let stem = lines[i].replace(startRe, '$1')
  if (stem) buf.push(stem)
  i++
  const opts = { A: '', B: '', C: '', D: '' }
  let curOpt = null
  for (; i < lines.length; i++) {
    const ln = lines[i]
    if (nextRe.test(ln)) break
    const optMatch = ln.match(/^\(?([A-D])\)?[.．、)]\s*(.*)$/)
    if (optMatch) { curOpt = optMatch[1]; opts[curOpt] = optMatch[2]; continue }
    if (curOpt) opts[curOpt] += ln
    else buf.push(ln)
  }
  const stemFull = buf.join('').trim()
  if (!stemFull || stemFull.length < 5) return null
  if (!opts.A || !opts.B || !opts.C || !opts.D) return null
  return { question: stemFull, options: opts }
}

;(async () => {
  const byFile = {}
  for (const t of TARGETS) {
    if (!byFile[t.file]) byFile[t.file] = []
    byFile[t.file].push(t)
  }
  let totalFixed = 0
  for (const [file, list] of Object.entries(byFile)) {
    const fp = path.join(__dirname, '..', file)
    const db = JSON.parse(fs.readFileSync(fp, 'utf8'))
    const qs = db.questions || db
    let fileFixed = 0
    for (const t of list) {
      const q = qs.find(x => x.id == t.id || x.id === String(t.id))
      if (!q) { console.log(`  ${file} id=${t.id}: NOT FOUND`); continue }
      const pdfs = findCachedPdfs(t.examPrefix, t.code)
      let parsed = null, usedPdf = null
      for (const p of pdfs) {
        try {
          const buf = fs.readFileSync(p)
          const txt = await fullPdfText(buf)
          const r = extractQA(txt, t.n)
          if (r) { parsed = r; usedPdf = path.basename(p); break }
        } catch (e) { /* try next */ }
      }
      if (!parsed) {
        console.log(`  ${file} id=${t.id} #${t.n}: no PDF match`)
        continue
      }
      console.log(`  ✓ ${file} id=${t.id} (${usedPdf})`)
      console.log(`    Q: ${parsed.question.slice(0, 80)}`)
      console.log(`    A: ${parsed.options.A.slice(0, 60)}`)
      console.log(`    B: ${parsed.options.B.slice(0, 60)}`)
      console.log(`    C: ${parsed.options.C.slice(0, 60)}`)
      console.log(`    D: ${parsed.options.D.slice(0, 60)}`)
      q.question = parsed.question
      q.options = parsed.options
      fileFixed++
      totalFixed++
    }
    if (fileFixed) {
      if (db.metadata) db.metadata.last_updated = new Date().toISOString()
      fs.writeFileSync(fp, JSON.stringify(db, null, 2))
    }
  }
  console.log(`\nTotal fixed: ${totalFixed}/${TARGETS.length}`)
})().catch(e => { console.error(e); process.exit(1) })
