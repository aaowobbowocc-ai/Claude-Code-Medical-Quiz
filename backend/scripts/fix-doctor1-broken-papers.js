#!/usr/bin/env node
// Re-parse 3 worst doctor1 papers using column-aware parser and fix
// questions where any option is empty/truncated.
//
// Targets (highest concentration of parser errors):
//   103-2 醫學(一)  (97 broken questions)
//   103-2 醫學(二)  (41 broken questions)
//   104-1 醫學(二)  (38 broken questions)
//
// Strategy: only replace question+options on rows where stored options have
// any empty/short field. Preserves id, answer, explanation, disputed, and all
// already-fixed questions (they no longer have empty options so are skipped).

const fs = require('fs')
const path = require('path')
const https = require('https')
const { parseColumnAware } = require('./lib/moex-column-parser')

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const QFILE = path.join(__dirname, '..', 'questions.json')

const TARGETS = [
  { year: '103', session: '第二次', subjectMatch: '一', examCode: '103100', c: '101', s: '0101' },
  { year: '103', session: '第二次', subjectMatch: '二', examCode: '103100', c: '101', s: '0102' },
  { year: '104', session: '第一次', subjectMatch: '二', examCode: '104030', c: '101', s: '0102' },
]

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

const isSus = v => {
  if (v == null || v === '') return true
  return String(v).trim().length <= 2
}
const hasEmpty = q => ['A','B','C','D'].some(k => isSus(q.options && q.options[k]))

// Reject parser output where any option looks like a fragment:
// - too short (< 4 chars) unless it matches common short chemistry/formula patterns
// - ends with a lowercase fragment pattern (e.g. "aldostero" / "ne" / "antihisto")
const SHORT_OK = /^(?:pH|O2|N2|H2|N2O|CO2|NO2|SO2|H2O|HCl|NaOH|K\+|Na\+|Ca\+\+|Mg\+\+|Cl-|HCO3|TSH|ACTH|ADH|ANP|LH|FSH|PCR|DNA|RNA|CRP|ESR|BMI|BMR|ABG|LDL|HDL|IgA|IgG|IgM|IgE|[A-Z]{1,4})$/
function suspiciousOption(s) {
  if (!s) return true
  const t = String(s).trim()
  if (t.length === 0) return true
  if (t.length < 4 && !SHORT_OK.test(t)) return true
  // Fragment: all-lowercase short latin ending (likely word cut in half)
  if (t.length <= 10 && /^[a-z]+$/.test(t) && !/\d|[A-Z]/.test(t)) return true
  return false
}
const parsedSane = p => ['A','B','C','D'].every(k => p.options[k] && !suspiciousOption(p.options[k]))

async function main() {
  const data = JSON.parse(fs.readFileSync(QFILE, 'utf8'))
  const arr = Array.isArray(data) ? data : data.questions

  const dryRun = process.argv.includes('--dry-run')
  let totalFixed = 0
  let totalSkipped = 0

  for (const t of TARGETS) {
    const url = `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=Q&code=${t.examCode}&c=${t.c}&s=${t.s}&q=1`
    console.log(`\n--- ${t.year}-${t.session} 醫學(${t.subjectMatch}) ---`)
    console.log('  URL:', url)
    const buf = await fetch(url)
    console.log('  PDF:', buf.length, 'bytes')
    const parsed = await parseColumnAware(buf)
    const parsedCount = Object.keys(parsed).length
    console.log('  Parsed questions:', parsedCount)

    const matches = arr.filter(q =>
      q.roc_year === t.year && q.session === t.session &&
      (q.subject || '').includes('醫學(' + t.subjectMatch + ')')
    )
    console.log('  Stored questions:', matches.length)

    let fixed = 0, skippedNoParse = 0, skippedClean = 0
    for (const q of matches) {
      if (!hasEmpty(q)) { skippedClean++; continue }
      const p = parsed[q.number]
      if (!p) { skippedNoParse++; continue }
      if (!parsedSane(p)) { skippedNoParse++; continue }
      // Apply
      q.question = p.question
      q.options = { A: p.options.A, B: p.options.B, C: p.options.C, D: p.options.D }
      fixed++
    }
    console.log('  Fixed:', fixed, '| Skipped (already clean):', skippedClean, '| Skipped (parse failed):', skippedNoParse)
    totalFixed += fixed
    totalSkipped += skippedNoParse
  }

  console.log(`\n=== Total fixed: ${totalFixed} | Parse failures: ${totalSkipped} ===`)

  if (dryRun) { console.log('(dry-run, no write)'); return }
  const tmp = QFILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, QFILE)
  console.log('\nwrote', QFILE)
}

main().catch(e => { console.error(e); process.exit(1) })
