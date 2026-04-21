#!/usr/bin/env node
// Probe 6 remaining missing questions: 4 nursing + 2 nutrition.
const fs = require('fs')
const path = require('path')
const https = require('https')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')
fs.mkdirSync(CACHE, { recursive: true })

const TARGETS = [
  { exam: 'nursing',   code: '112030', c: '102', s: '0201', subject: '基礎醫學',              n: 23 },
  { exam: 'nursing',   code: '112030', c: '102', s: '0202', subject: '基本護理學與護理行政',    n: 65 },
  { exam: 'nursing',   code: '112030', c: '102', s: '0203', subject: '內外科護理學',            n: 9  },
  { exam: 'nursing',   code: '113100', c: '102', s: '0202', subject: '基本護理學與護理行政',    n: 43 },
  { exam: 'nutrition', code: '113100', c: '101', s: '0105', subject: '公共衛生營養學',          n: 31 },
  { exam: 'nutrition', code: '113100', c: '101', s: '0104', subject: '營養學',                  n: 42 },
]

function fetchPdf(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 25000,
      headers: { 'User-Agent': UA, 'Accept': 'application/pdf,*/*', 'Referer': 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location
        if (!loc || !loc.startsWith('http')) { res.resume(); return reject(new Error('bad redirect')) }
        return fetchPdf(loc).then(resolve, reject)
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function cached(exam, t, code, c, s) {
  const key = `${exam}_${t}_${code}_c${c}_s${s}.pdf`
  const p = path.join(CACHE, key)
  if (fs.existsSync(p) && fs.statSync(p).size > 1000) return fs.readFileSync(p)
  const url = `${BASE}?t=${t}&code=${code}&c=${c}&s=${s}&q=1`
  console.log('  fetching', url)
  try {
    const buf = await fetchPdf(url)
    if (buf.length > 1000) fs.writeFileSync(p, buf)
    return buf
  } catch (e) { console.log('  fetch failed:', e.message); return null }
}

async function pdfLines(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const nP = doc.countPages()
  const lines = []
  for (let pi = 0; pi < nP; pi++) {
    const pg = doc.loadPage(pi)
    const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
    for (const b of parsed.blocks || []) {
      if (b.type !== 'text') continue
      for (const ln of (b.lines || [])) {
        const t = (ln.text || '').trim()
        if (!t) continue
        lines.push({ pi, y: pi * 10000 + Math.round(ln.bbox.y), ly: Math.round(ln.bbox.y), x: Math.round(ln.bbox.x), text: ln.text })
      }
    }
  }
  lines.sort((a, b) => a.y - b.y || a.x - b.x)
  return lines
}

;(async () => {
  for (const t of TARGETS) {
    console.log(`\n=== ${t.exam} ${t.code}/${t.subject} #${t.n} ===`)
    const qBuf = await cached(t.exam, 'Q', t.code, t.c, t.s)
    if (!qBuf) { console.log('  no Q pdf'); continue }
    const lines = await pdfLines(qBuf)
    const n = t.n
    // Find anchor: line text begins with the number
    const isAnchor = (ln, num) => {
      if (ln.x > 100) return false
      const tx = ln.text.trim()
      if (tx === String(num)) return true
      const m = tx.match(/^(\d{1,3})\s*[.．、]?\s*(.*)$/)
      return !!(m && parseInt(m[1]) === num)
    }
    // Find best anchor: one preceded by n-1 anchor nearby
    let anchorIdx = -1
    const cands = []
    for (let i = 0; i < lines.length; i++) if (isAnchor(lines[i], n)) cands.push(i)
    for (const ci of cands) {
      for (let j = ci - 1; j >= Math.max(0, ci - 60); j--) {
        if (lines[j].x > 100) continue
        const m = lines[j].text.trim().match(/^(\d{1,3})/)
        if (m) { if (parseInt(m[1]) === n - 1) { anchorIdx = ci; break } else break }
      }
      if (anchorIdx >= 0) break
    }
    if (anchorIdx < 0 && cands.length) anchorIdx = cands[cands.length - 1]
    if (anchorIdx < 0) { console.log('  anchor not found'); continue }

    // Dump context: anchor-2 to anchor+30
    const start = Math.max(0, anchorIdx - 2)
    let end = Math.min(lines.length, anchorIdx + 30)
    for (let i = anchorIdx + 1; i < Math.min(lines.length, anchorIdx + 30); i++) {
      if (lines[i].x <= 100 && /^(\d{1,3})/.test(lines[i].text.trim()) && parseInt(lines[i].text.trim()) === n + 1) { end = i; break }
    }
    for (let i = start; i < end; i++) {
      const ln = lines[i]
      console.log(`  p${ln.pi} y${ln.ly} x${ln.x}: ${ln.text}`)
    }

    // Fetch answer
    const sBuf = await cached(t.exam, 'S', t.code, t.c, t.s)
    if (sBuf) {
      const sLines = await pdfLines(sBuf)
      const full = sLines.map(l => l.text).join('\n')
      // Find block "第Nx題 ... 答案 ABCD"
      const rows = full.split('\n')
      const targetIdx = rows.findIndex(r => r.trim() === `第${n}題`)
      if (targetIdx >= 0) {
        // Find the "答案" line after this row that's within ~15 rows
        for (let i = targetIdx + 1; i < Math.min(rows.length, targetIdx + 15); i++) {
          if (rows[i].trim() === '答案') {
            // Count back from targetIdx to start of题號 block
            // rows[i+1 + offset] corresponds to row[targetIdx + offset - blockStart]
            // Simpler: find block start (題號)
            let bs = targetIdx - 1
            while (bs >= 0 && rows[bs].trim() !== '題號') bs--
            const offset = targetIdx - bs - 1  // 1-indexed position in block
            const ans = rows[i + offset]
            console.log(`  >> ANSWER: #${n} = ${ans?.trim()}`)
            break
          }
        }
      } else {
        // Fallback — dump first 1500 chars of S PDF
        console.log('  (no 第N題 label found; dumping S text)')
        console.log(full.slice(0, 1500))
      }
    }
  }
})().catch(e => { console.error(e); process.exit(1) })
