#!/usr/bin/env node
// Fix the 5 truncated question stems found by the audit.
// Each target maps (file, id) → expected exam_code, subject, number, and the
// PDF location (class+subject codes) to extract the real stem from.
const fs = require('fs')
const path = require('path')
const https = require('https')

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')
fs.mkdirSync(PDF_CACHE, { recursive: true })

function fetchPdf(url) {
  return new Promise((res, rej) => {
    https.get(url, {
      rejectUnauthorized: false, timeout: 25000,
      headers: { 'User-Agent': UA, 'Accept': 'application/pdf,*/*' },
    }, r => {
      if (r.statusCode === 301 || r.statusCode === 302) {
        const loc = r.headers.location
        if (!loc || !loc.startsWith('http')) return rej(new Error('bad redirect'))
        return fetchPdf(loc).then(res, rej)
      }
      if (r.statusCode !== 200) return rej(new Error('HTTP ' + r.statusCode))
      const cs = []; r.on('data', c => cs.push(c)); r.on('end', () => res(Buffer.concat(cs)))
    }).on('error', rej)
  })
}

async function loadPdf(prefix, code, c, s) {
  // Some files use prefix `nutrition_Q_` (older) or `${exam}_${code}_c${c}_s${s}.pdf`.
  // Try a couple of candidates.
  const candidates = [
    `${prefix}_Q_${code}_c${c}_s${s}.pdf`,
    `${prefix}_${code}_c${c}_s${s}.pdf`,
  ]
  for (const k of candidates) {
    const p = path.join(PDF_CACHE, k)
    if (fs.existsSync(p) && fs.statSync(p).size > 1000) return fs.readFileSync(p)
  }
  // Download
  const url = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
  const buf = await fetchPdf(url)
  fs.writeFileSync(path.join(PDF_CACHE, candidates[1]), buf)
  return buf
}

async function pageText(pg) {
  const parsed = JSON.parse(pg.toStructuredText('preserve-images').asJSON())
  const lines = []
  for (const b of parsed.blocks || []) {
    if (b.type !== 'text') continue
    for (const ln of (b.lines || [])) {
      const t = ln.text || ''
      if (!t.trim()) continue
      lines.push({ y: Math.round(ln.bbox.y), x: Math.round(ln.bbox.x), text: t })
    }
  }
  lines.sort((a, b) => a.y - b.y || a.x - b.x)
  // Group by y (column-aware)
  const groups = []
  for (const ln of lines) {
    const last = groups[groups.length - 1]
    if (last && Math.abs(last.y - ln.y) <= 3) last.parts.push(ln)
    else groups.push({ y: ln.y, parts: [ln] })
  }
  return groups.map(g => g.parts.sort((a, b) => a.x - b.x).map(p => p.text).join('')).join('\n')
}

async function fullPdfText(buf) {
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) {
    txt += await pageText(doc.loadPage(i)) + '\n'
  }
  return txt
}

// Extract the full stem of question N from raw PDF text.
function extractStem(text, N) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  let collecting = false, buf = []
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    if (!collecting) {
      const m = ln.match(new RegExp(`^${N}[.．、]\\s*(.*)`))
      if (m && m[1] && m[1].length >= 2) {
        collecting = true
        buf.push(m[1])
      }
      continue
    }
    // Stop on next question or first option
    if (/^([A-D])[.．]\s*/.test(ln)) break
    if (new RegExp(`^${N + 1}[.．、]\\s*`).test(ln)) break
    buf.push(ln)
  }
  return buf.join('').trim()
}

const TARGETS = [
  // medlab 112100 #69 臨床血液學與血庫學
  { file: 'questions-medlab.json', id: 3989, prefix: 'medlab', code: '112100', c: '308', sCandidates: ['0501', '22'], n: 69 },
  // nutrition 113100 #32 公衛營養 (cached as 0105)
  { file: 'questions-nutrition.json', id: '113100_public_nutrition_32', prefix: 'nutrition', code: '113100', c: '101', sCandidates: ['0105'], n: 32 },
  // nutrition 113100 #46 公衛營養
  { file: 'questions-nutrition.json', id: '113100_public_nutrition_46', prefix: 'nutrition', code: '113100', c: '101', sCandidates: ['0105'], n: 46 },
  // ot 114090 #12 心理疾病職能治療學
  { file: 'questions-ot.json', id: 252, prefix: 'ot', code: '114090', c: '312', sCandidates: ['0803', '44'], n: 12 },
  // vet 110100 #63 獸醫病理學 (vet uses 2-digit subject codes)
  { file: 'questions-vet.json', id: 63, prefix: 'vet', code: '110100', c: '314', sCandidates: ['11'], n: 63 },
]

;(async () => {
  for (const t of TARGETS) {
    console.log(`\n=== ${t.file} id=${t.id} ${t.code}#${t.n} ===`)
    let stem = null, usedS = null
    for (const s of t.sCandidates) {
      try {
        const buf = await loadPdf(t.prefix, t.code, t.c, s)
        if (buf.length < 2000) continue
        const txt = await fullPdfText(buf)
        const candidate = extractStem(txt, t.n)
        if (candidate && candidate.length >= 8) {
          // Prefer the one that contains a 中文-like stem
          stem = candidate
          usedS = s
          break
        }
      } catch (e) { console.error(`  s=${s} failed: ${e.message}`) }
    }
    if (stem) {
      console.log(`  found in s=${usedS}:`)
      console.log(`  →`, stem.slice(0, 200))
    } else {
      console.log('  ❌ NOT FOUND')
    }
  }
})().catch(e => { console.error(e); process.exit(1) })
