#!/usr/bin/env node
// Repair the 4 problematic results from fix-residual-empty-options.js:
//   1. nutrition 400  — restore original stem, blank options (no c102 PDF cached
//      for 115030 — c101 cache is actually 護理師, not 營養師)
//   2. pharma1 115020383 — re-extract from correct PDF series (115020_c305_s04xx),
//      not the wrong 110101 the DB had
//   3. doctor1 112100_1_66 — attempt cleaner re-extraction from s11
//   4. pt 5122 — strip "座號" noise from option C
const fs = require('fs')
const path = require('path')

const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')

async function fullPdfText(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) {
    const pg = doc.loadPage(i)
    const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
    // Two-column: collect lines, separate by x<300 vs x>=300, sort each by y
    const left = [], right = []
    for (const b of parsed.blocks || []) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const t = (ln.text || '').trim()
        if (!t) continue
        const e = { y: Math.round(ln.bbox.y * 10) / 10, x: ln.bbox.x, text: t }
        if (ln.bbox.x < 300) left.push(e)
        else right.push(e)
      }
    }
    const grp = arr => {
      arr.sort((a, b) => a.y - b.y || a.x - b.x)
      const groups = []
      for (const ln of arr) {
        const last = groups[groups.length - 1]
        if (last && Math.abs(last.y - ln.y) <= 3) last.parts.push(ln)
        else groups.push({ y: ln.y, parts: [ln] })
      }
      return groups.map(g => g.parts.sort((a, b) => a.x - b.x).map(p => p.text).join(''))
    }
    txt += [...grp(left), ...grp(right)].join('\n') + '\n'
  }
  return txt
}

function extractQA(text, N) {
  // Strip header/footer noise lines first
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    .filter(l => !/^座號|准考證|代號|頁次/.test(l))
  let i = 0
  const startRe = new RegExp(`^${N}[.．、]\\s*(.*)$`)
  const nextRe = new RegExp(`^${N + 1}[.．、]\\s*`)
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
  // Strip trailing form noise from each option
  for (const k of 'ABCD') {
    opts[k] = opts[k].replace(/座號[:：]?_*$/, '').trim()
  }
  const stemFull = buf.join('').trim()
  if (!stemFull) return null
  if (!opts.A || !opts.B || !opts.C || !opts.D) return null
  return { question: stemFull, options: opts }
}

async function tryExtract(pdfNames, N) {
  for (const name of pdfNames) {
    const p = path.join(PDF_CACHE, name)
    if (!fs.existsSync(p)) continue
    try {
      const buf = fs.readFileSync(p)
      const txt = await fullPdfText(buf)
      const r = extractQA(txt, N)
      if (r) return { ...r, pdf: name }
    } catch {}
  }
  return null
}

;(async () => {
  // 1. Restore nutrition 400 — original stem, options blank (no valid PDF cached)
  {
    const fp = path.join(__dirname, '..', 'questions-nutrition.json')
    const db = JSON.parse(fs.readFileSync(fp, 'utf8'))
    const q = db.questions.find(x => x.id === 400)
    q.question = ' 根據琥珀酸（succinate）的化學結構式（如圖所示），下列何者最可能為琥珀酸去氫酶 （succinate dehydrogenase）作用於琥珀酸的競爭型抑制劑（competitive inhibitor）？'
    q.options = { A: '', B: '', C: '', D: '' }
    if (db.metadata) db.metadata.last_updated = new Date().toISOString()
    fs.writeFileSync(fp, JSON.stringify(db, null, 2))
    console.log('  ✓ nutrition 400: restored original stem')
  }

  // 2. pharma1 115020383 — try extracting from 115020_c305_s04xx (paper 2 = 藥物分析與生藥學)
  {
    const fp = path.join(__dirname, '..', 'questions-pharma1.json')
    const db = JSON.parse(fs.readFileSync(fp, 'utf8'))
    const q = db.questions.find(x => x.id === 115020383)
    const r = await tryExtract([
      'pharma1_115020_c305_s0402.pdf',
      'pharma1_115020_c305_s0401.pdf',
      'pharma1_115020_c305_s0403.pdf',
    ], 23)
    if (r && r.question.includes('NMR') || r && r.question.includes('磁共振')) {
      console.log(`  ✓ pharma1 115020383: extracted from ${r.pdf}`)
      q.question = r.question
      q.options = r.options
    } else {
      // Restore original
      q.question = '如在achiral D-solvent中測氫核磁共振譜，則下列標記的氫訊號何者為雙重峰（doublet）？'
      q.options = { A: '', B: '', C: '', D: '' }
      console.log(`  ⚠ pharma1 115020383: restored original (no NMR match found, parsed=${r?.question?.slice(0,40)})`)
    }
    if (db.metadata) db.metadata.last_updated = new Date().toISOString()
    fs.writeFileSync(fp, JSON.stringify(db, null, 2))
  }

  // 3. doctor1 112100_1_66 — try cleaner extraction
  {
    const fp = path.join(__dirname, '..', 'questions.json')
    const db = JSON.parse(fs.readFileSync(fp, 'utf8'))
    const q = db.questions.find(x => x.id === '112100_1_66')
    const r = await tryExtract(['doctor1_112100_c301_s11.pdf'], 66)
    if (r && r.question.includes('Bartter') && !r.options.C.includes('試管')) {
      console.log(`  ✓ doctor1 112100_1_66: clean extraction`)
      q.question = r.question
      q.options = r.options
    } else {
      console.log(`  ⚠ doctor1 112100_1_66: leaving previous (still partial). Parsed C: ${r?.options?.C?.slice(0,60)}`)
    }
    if (db.metadata) db.metadata.last_updated = new Date().toISOString()
    fs.writeFileSync(fp, JSON.stringify(db, null, 2))
  }

  // 4. pt 5122 — strip 座號 noise from option C
  {
    const fp = path.join(__dirname, '..', 'questions-pt.json')
    const db = JSON.parse(fs.readFileSync(fp, 'utf8'))
    const q = db.questions.find(x => x.id === 5122)
    if (q && q.options?.C) {
      const before = q.options.C
      q.options.C = q.options.C.replace(/座號[:：]?_+/, '').trim()
      console.log(`  ✓ pt 5122: option C cleaned`)
      console.log(`    before: ${before}`)
      console.log(`    after : ${q.options.C}`)
    }
    if (db.metadata) db.metadata.last_updated = new Date().toISOString()
    fs.writeFileSync(fp, JSON.stringify(db, null, 2))
  }
})().catch(e => { console.error(e); process.exit(1) })
