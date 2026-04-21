// Download each (code,c,s) PDF, parse first page header → extract 類科 + 科目.
// Dedup by file size (cross-listed PDFs share the same bytes).
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const probeRes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'probe-100-104-secondsess.json'), 'utf8'))

// Group: dedup by (code, size) — same size in same session = same PDF
const seen = new Set()
const unique = []
for (const r of probeRes) {
  const k = `${r.code}|${r.size}`
  if (seen.has(k)) { r.dup = true; continue }
  seen.add(k)
  unique.push(r)
}
console.log(`Unique PDFs to identify: ${unique.length} (from ${probeRes.length} total)`)

function fetch(url) {
  return new Promise((res, rej) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 30000 }, r => {
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode)) }
      const chunks = []
      r.on('data', c => chunks.push(c))
      r.on('end', () => res(Buffer.concat(chunks)))
    })
    req.on('error', rej)
    req.on('timeout', () => { req.destroy(); rej(new Error('timeout')) })
  })
}

function extractMeta(text) {
  // Common MoEX header patterns
  const lines = text.split('\n').slice(0, 30).map(l => l.trim()).filter(Boolean)
  const head = lines.join(' / ')
  // Try to find 類科 and 科目
  let leikoMatch = text.match(/類\s*科[：:]\s*([^\n科]+)/)
  let subjMatch = text.match(/科\s*目[：:]\s*([^\n]+)/)
  return {
    leiko: leikoMatch ? leikoMatch[1].trim() : null,
    subject: subjMatch ? subjMatch[1].trim() : null,
    head: head.slice(0, 200),
  }
}

async function run() {
  const out = []
  let done = 0
  const CONC = 6
  let idx = 0
  async function worker() {
    while (idx < unique.length) {
      const t = unique[idx++]
      try {
        const buf = await fetch(t.url)
        const parsed = await pdfParse(buf, { max: 1 })
        const meta = extractMeta(parsed.text)
        out.push({ ...t, ...meta })
        process.stderr.write(`  ${++done}/${unique.length} ${t.code} c=${t.c} s=${t.s} → ${meta.leiko || '?'} | ${meta.subject || '?'}\n`)
      } catch (e) {
        out.push({ ...t, err: e.message })
        process.stderr.write(`  ${++done}/${unique.length} ${t.code} c=${t.c} s=${t.s} ERR ${e.message}\n`)
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker))
  fs.writeFileSync(path.join(__dirname, '..', 'pdf-identification.json'), JSON.stringify(out, null, 2))
  console.log(`\nWrote pdf-identification.json (${out.length} entries)`)
  // Build summary
  const grouped = {}
  for (const r of out) {
    if (!r.leiko) continue
    const k = `${r.code}|${r.leiko}`
    grouped[k] = grouped[k] || []
    grouped[k].push({ c: r.c, s: r.s, subject: r.subject })
  }
  console.log('\n--- By (code, 類科) ---')
  for (const [k, arr] of Object.entries(grouped).sort()) {
    console.log(k)
    for (const a of arr) console.log(`  c=${a.c} s=${a.s} → ${a.subject}`)
  }
}
run()
