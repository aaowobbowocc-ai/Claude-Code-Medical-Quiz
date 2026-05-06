#!/usr/bin/env node
/**
 * Fix doctor1 醫學(一) / 醫學(二) Q1-100 answers across ALL years using
 * 考選部 t=M (測驗題標準答案更正) PDFs.
 *
 * Bug being fixed:
 * Original scraper read 100-Q exam standard-answer PDF rows in wrong order
 * for Q61-100. M PDFs have unambiguous per-question listing.
 *
 * Special grading semantics (from 備註):
 *   - "一律給分"          → keep original answer + disputed:true
 *   - "答X或Y或XY給分"   → keep original answer + disputed:true
 *   - "答X給分" 單字母    → set answer to X + disputed:true
 */

const fs = require('fs')
const path = require('path')
const https = require('https')

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const BACKEND = path.join(__dirname, '..')
const PDF_CACHE = path.join(BACKEND, '_tmp', 'pdf-cache')

const stripPUA = s => s.replace(/[-]/g, '').normalize('NFKC')

const TARGETS = [
  // [exam_code, c, s_yixue1, s_yixue2]  c=class code differs by year
  // 100-103: c=101, s=0101 (醫一), s=0102 (醫二)
  ['100030', '101', '0101', '0102'],
  ['100140', '101', '0101', '0102'],
  ['101030', '101', '0101', '0102'],
  ['101110', '101', '0101', '0102'],
  // 102-103 第二次: 102110, 103100 c=101 (verified for 102110 & 103100 by CLAUDE.md)
  ['102030', '101', '0101', '0102'],
  ['102110', '101', '0101', '0102'],
  ['103030', '101', '0101', '0102'],
  ['103100', '101', '0101', '0102'],
  // 104-105 special: question PDFs use c=301 s=55/66 (104090, 105020, 105100, 106020, 107020 etc)
  ['104030', '101', '0101', '0102'],  // 104030 still uses c=101
  ['104090', '301', '55', '66'],
  ['105020', '301', '55', '66'],
  ['105100', '301', '55', '66'],
  ['106020', '301', '55', '66'],
  ['106100', '301', '11', '22'],
  ['107020', '301', '55', '66'],
  ['107100', '301', '11', '22'],
  // 108+: all use c=301 s=11/22
  ['108030', '301', '11', '22'],
  ['108100', '301', '11', '22'],
  ['109020', '301', '11', '22'],
  ['109100', '301', '11', '22'],
  ['110020', '301', '11', '22'],
  ['110101', '301', '11', '22'],
  ['111020', '301', '11', '22'],
  ['111100', '301', '11', '22'],
  ['112020', '301', '11', '22'],
  ['112100', '301', '11', '22'],
  ['113020', '301', '11', '22'],
  ['113090', '301', '11', '22'],
  ['114020', '301', '0101', '0102'],
  ['114090', '301', '0101', '0102'],
  ['115020', '301', '0101', '0102'],
]

function get(url) {
  return new Promise(resolve => {
    https.get(url, { agent: new https.Agent({ rejectUnauthorized: false }) }, r => {
      if (r.statusCode !== 200) { r.destroy(); return resolve(null) }
      const ch = []
      r.on('data', c => ch.push(c))
      r.on('end', () => resolve(Buffer.concat(ch)))
    }).on('error', () => resolve(null))
  })
}

async function downloadM(code, c, s) {
  // Try t=M (updates), fall back to t=S (standard) if M missing
  for (const t of ['M', 'S']) {
    const file = path.join(PDF_CACHE, `T${t}_doctor1_${code}_c${c}_s${s}.pdf`)
    if (fs.existsSync(file) && fs.statSync(file).size > 1000) return file
    const url = `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=${t}&code=${code}&c=${c}&s=${s}&q=1`
    const buf = await get(url)
    if (buf && buf.length > 1000) {
      fs.writeFileSync(file, buf)
      return file
    }
  }
  return null
}

async function readPdf(p) {
  const mupdf = await import('mupdf')
  const buf = fs.readFileSync(p)
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) txt += '\n' + doc.loadPage(i).toStructuredText('preserve-whitespace').asText()
  return stripPUA(txt)
}

function extractLetters(txt) {
  // Strip the preface "答案標註#者" where # is a literal symbol (not data).
  // Replace just that "#" with a non-A-D placeholder.
  txt = txt.replace(/答案標註#者/g, '答案標註X者').replace(/標註#者/g, '標註X者')
  // Determine data area: prefer "測驗題標準答案更正" anchor; otherwise scan whole doc.
  let dataArea = txt
  const anchor = txt.search(/測驗題標準答案更正/)
  if (anchor >= 0) dataArea = txt.slice(anchor)
  // Stop at the start of 備註 *explanation text* (which mentions "第N題..."),
  // not the bare "備註:" header (some PDFs misorder it before final data block).
  // Also stop at "複選題數" which always indicates end of single-choice section.
  let end = dataArea.length
  const stopPatterns = [
    /第\d+題[一答]/,        // 備註 explanation: "第49題答A、D給分" or "第51題一律給分"
    /複選題數/,
    /複選每題配分/,
  ]
  for (const re of stopPatterns) {
    const m = dataArea.match(re)
    if (m && m.index < end) end = m.index
  }
  dataArea = dataArea.slice(0, end)
  return dataArea.match(/(?<![A-Z0-9])[A-D#](?![A-Z0-9])/g) || []
}

function parseMPdf(txt) {
  const letters = extractLetters(txt)
  if (letters.length < 100) return null

  const noteMatch = txt.match(/備\s*註[：:]([\s\S]+)/)
  const note = noteMatch ? noteMatch[1].replace(/\n/g, '') : ''
  const disputed = new Set()
  const corrections = {}
  for (const m of note.matchAll(/第(\d+)題一律給分/g)) disputed.add(+m[1])
  for (const m of note.matchAll(/第(\d+)題答([A-D]+(?:或[A-D]+)+)(?:者均)?給分/g)) disputed.add(+m[1])
  for (const m of note.matchAll(/第(\d+)題答([A-D])給分(?![或、])/g)) {
    corrections[+m[1]] = m[2]
    disputed.add(+m[1])
  }

  return letters.slice(0, 100).map((a, i) => {
    const qn = i + 1
    if (a === '#') {
      if (corrections[qn]) return { qn, ans: corrections[qn], disputed: true }
      return { qn, ans: null, disputed: true }
    }
    return { qn, ans: a, disputed: disputed.has(qn) }
  })
}

async function fixOnePaper(arr, code, jsonSubject, c, s, dryRun) {
  const pdfPath = await downloadM(code, c, s)
  if (!pdfPath) return { code, subject: jsonSubject, status: 'PDF_MISSING', changed: 0, disputed: 0 }
  const txt = await readPdf(pdfPath)
  const parsed = parseMPdf(txt)
  if (!parsed) return { code, subject: jsonSubject, status: 'PARSE_FAIL', changed: 0, disputed: 0 }
  let changed = 0, disputedSet = 0
  for (const { qn, ans, disputed } of parsed) {
    const q = arr.find(x => x.exam_code === code && x.subject === jsonSubject && x.number === qn)
    if (!q) continue
    if (ans && q.answer !== ans) {
      if (!dryRun) q.answer = ans
      changed++
    }
    if (disputed && !q.disputed) {
      if (!dryRun) q.disputed = true
      disputedSet++
    }
  }
  return { code, subject: jsonSubject, status: 'OK', changed, disputed: disputedSet }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const filePath = path.join(BACKEND, 'questions.json')
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const arr = data.questions || data

  let totalChanged = 0, totalDisputed = 0
  const failures = []
  for (const [code, c, s1, s2] of TARGETS) {
    for (const [s, subj] of [[s1, '醫學(一)'], [s2, '醫學(二)']]) {
      const r = await fixOnePaper(arr, code, subj, c, s, dryRun)
      const tag = r.status === 'OK' ? '✓' : '✗'
      console.log(`  ${tag} ${code} ${subj}: ${r.changed} changed, ${r.disputed} disputed [${r.status}]`)
      if (r.status !== 'OK') failures.push({ code, subj, s, status: r.status })
      totalChanged += r.changed
      totalDisputed += r.disputed
    }
  }
  if (!dryRun) fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
  console.log(`\n=== TOTAL ===`)
  console.log(`Changed: ${totalChanged} | Disputed: ${totalDisputed} ${dryRun ? '(DRY RUN — not saved)' : '(saved)'}`)
  if (failures.length) console.log(`Failures: ${failures.length}`, failures.slice(0, 10))
}

main().catch(e => { console.error(e); process.exit(1) })
