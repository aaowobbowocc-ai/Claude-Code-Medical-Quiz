#!/usr/bin/env node
// Probe MoEX for social-worker PDF URL params (112-115 年).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const https = require('https')
const fs = require('fs')
const path = require('path')
const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')

function fetchBuf(url) {
  return new Promise((resolve) => {
    https.get(url, { timeout: 15000 }, res => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null) }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    }).on('error', () => resolve(null)).on('timeout', function () { this.destroy(); resolve(null) })
  })
}

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }
async function pdfFirstText(buf) {
  try {
    const mupdf = await getMupdf()
    const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
    return doc.loadPage(0).toStructuredText('preserve-whitespace').asText().normalize('NFKC')
  } catch { return '' }
}

const SESSIONS = ['112030', '112110', '113030', '113100', '114030', '114100', '115030']
// social-worker has 3 papers; class code likely 103; try several s-code schemes
const C_CODES = ['103', '101', '102']
const S_SCHEMES = [
  ['0301', '0302', '0303'], ['0401', '0402', '0403'],
  ['0601', '0602', '0603'], ['0201', '0202', '0203'],
  ['0103', '0104', '0105'],
]

async function main() {
  const found = []
  for (const code of SESSIONS) {
    let hit = null
    for (const c of C_CODES) {
      if (hit) break
      for (const scheme of S_SCHEMES) {
        const url = `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=Q&code=${code}&c=${c}&s=${scheme[0]}&q=1`
        const buf = await fetchBuf(url)
        if (!buf || buf.length < 2000) continue
        const txt = await pdfFirstText(buf)
        if (/社會工作師|社工師/.test(txt) || /社會工作[^師]/.test(txt)) {
          hit = { code, c, scheme }
          console.log(`✓ ${code} c=${c} s=${scheme.join(',')} — ${txt.slice(0, 60).replace(/\n/g, ' ')}`)
          break
        }
      }
    }
    if (!hit) console.log(`✗ ${code} — no match`)
    else found.push(hit)
  }
  fs.writeFileSync(path.join(__dirname, '_sw-probe.json'), JSON.stringify(found, null, 2))
  console.log('\nfound:', found.length, '→ saved _sw-probe.json')
}
main()
