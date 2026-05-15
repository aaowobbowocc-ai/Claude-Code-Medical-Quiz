#!/usr/bin/env node
// Audit disputed flag against M PDFs (考選部 correction announcements)
// Strategy: parse all M PDFs to build (exam_code, s_code, number) → reason set.
// Then for each disputed=true entry, check if it's in the verified-disputed set.
// Only reports — does NOT modify files.

const fs = require('fs')
const path = require('path')
const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }
async function readText(buf) {
  const mupdf = await getMupdf()
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) txt += doc.loadPage(i).toStructuredText('preserve-whitespace').asText()
  return txt.normalize('NFKC')
}

// Parse correction PDF text → list of { number, reason }
// Strategy: extract ONLY the 備註 section (corrections explicitly listed there).
// The answer key table has "第X題" for EVERY question — must skip those.
function parseCorrections(txt) {
  const corrections = []
  // Find 備註 / 備  註 section
  const idx = txt.search(/備\s*註\s*[:：]/)
  if (idx < 0) return corrections
  const after = txt.slice(idx)
  // End at "標準答案" line (any further-down note) or end of doc
  const endIdx = after.search(/標準答案[：:]?答案標註/)
  const remarks = endIdx > 0 ? after.slice(0, endIdx) : after
  // Match each correction inside 備註
  const re = /第\s*(\d+)\s*題[^第]*?(送分|一律給分|均給分|答[A-DＡ-Ｄ\s或]+?給分|修正為|更正為)/g
  let m
  while ((m = re.exec(remarks)) !== null) {
    corrections.push({ number: parseInt(m[1]), reason: m[2].trim() })
  }
  return corrections
}

async function main() {
  // 1. Build verified-disputed set: (exam_code|s_code) → Set<number>
  const verified = {}
  const mFiles = fs.readdirSync(PDF_CACHE).filter(f => /^M_\d{5,6}_c\w+_s\w+\.pdf$/.test(f))
  console.log('Parsing', mFiles.length, 'M PDFs...')
  for (const f of mFiles) {
    const m = f.match(/^M_(\d{5,6})_c(\w+)_s(\w+)\.pdf$/)
    if (!m) continue
    const code = m[1], s = m[3]
    try {
      const buf = fs.readFileSync(path.join(PDF_CACHE, f))
      const txt = await readText(buf)
      const corrs = parseCorrections(txt)
      const key = `${code}|${s}`
      if (!verified[key]) verified[key] = { numbers: new Set(), file: f, sample: corrs.slice(0, 3) }
      for (const c of corrs) verified[key].numbers.add(c.number)
    } catch (e) { /* skip */ }
  }
  console.log('Verified-disputed (exam_code|s_code) keys:', Object.keys(verified).length)
  let totalVerified = 0
  for (const v of Object.values(verified)) totalVerified += v.numbers.size
  console.log('Total verified-disputed entries:', totalVerified)
  console.log('Sample:', Object.entries(verified).slice(0, 5).map(([k, v]) =>
    `${k}: ${v.numbers.size} (${v.sample.map(s => '#'+s.number+' '+s.reason).join(', ')})`).join('\n  '))

  // 2. For each disputed=true question, check membership
  const files = ['questions.json','questions-doctor2.json','questions-dental1.json','questions-dental2.json',
    'questions-pharma1.json','questions-pharma2.json','questions-tcm1.json','questions-tcm2.json',
    'questions-nursing.json','questions-nutrition.json','questions-medlab.json','questions-pt.json',
    'questions-ot.json','questions-radiology.json','questions-vet.json','questions-social-worker.json',
    'questions-audiologist.json','questions-speech-therapist.json','questions-rt.json']

  const APPLY = process.argv.includes('--apply')
  let totalDisputed = 0, hasMPDF = 0, inVerified = 0, falseDisputed = 0
  const falseByFile = {}
  const filesToWrite = {}
  for (const fp of files) {
    if (!fs.existsSync(fp)) continue
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'))
    const arr = data.questions || data
    let modified = false
    for (const q of arr) {
      if (!q.disputed) continue
      totalDisputed++
      // ID format: {exam_code}_{s_code}_{number} OR {exam_code}_{seq}
      let sCode = null
      const idMatch = String(q.id).match(/^\d{5,6}_(\w+)_\d+$/)
      if (idMatch) sCode = idMatch[1]
      // Strict lookup: SPECIFIC exam_code+s_code key must exist
      const specificKey = sCode ? `${q.exam_code}|${sCode}` : null
      const hasM = !!(specificKey && verified[specificKey])
      let foundInVerified = false
      if (hasM && verified[specificKey].numbers.has(q.number)) foundInVerified = true
      if (hasM) hasMPDF++
      if (foundInVerified) inVerified++
      else if (hasM) {
        falseDisputed++
        falseByFile[fp] = (falseByFile[fp] || 0) + 1
        if (APPLY) {
          delete q.disputed
          modified = true
        }
      }
    }
    if (modified) filesToWrite[fp] = data
  }
  if (APPLY) {
    for (const [fp, data] of Object.entries(filesToWrite)) {
      fs.writeFileSync(fp, JSON.stringify(data, null, 2))
      console.log('  ✏️  wrote', fp)
    }
  }
  console.log('\n=== AUDIT REPORT ===')
  console.log('Total disputed=true entries:', totalDisputed)
  console.log('  ├─ exam_code has M PDF:', hasMPDF)
  console.log('  │  ├─ verified by M PDF:', inVerified)
  console.log('  │  └─ FALSE disputed (M PDF exists but # not in corrections):', falseDisputed)
  console.log('  └─ no M PDF available:', totalDisputed - hasMPDF)
  console.log('\nFalse disputed by file:')
  for (const [f, c] of Object.entries(falseByFile).sort((a, b) => b[1] - a[1])) console.log(' ', c, f)
}

main().catch(e => { console.error(e); process.exit(1) })
