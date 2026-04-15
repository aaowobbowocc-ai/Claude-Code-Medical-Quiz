process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const https = require('https')
const pdfParse = require('pdf-parse')
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'

function fetchBuf(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false, timeout: 15000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*',
                 Referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' } },
      res => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
        const ct = res.headers['content-type'] || ''
        if (!ct.includes('pdf') && !ct.includes('octet')) { res.resume(); return reject(new Error('ct=' + ct)) }
        const cs = []
        res.on('data', c => cs.push(c))
        res.on('end', () => resolve(Buffer.concat(cs)))
      }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')) })
  })
}

async function probe(code, c, s) {
  const url = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
  try {
    const buf = await fetchBuf(url)
    const { text } = await pdfParse(buf)
    const first = text.slice(0, 400).replace(/\s+/g, ' ').trim()
    return { ok: true, head: first }
  } catch (e) {
    return { ok: false, err: e.message.slice(0, 30) }
  }
}

async function main() {
  const combos = [
    { code: '112110', c: '101' },
    { code: '112110', c: '102' },
    { code: '112100', c: '102' },
    { code: '112090', c: '102' },
  ]
  for (const combo of combos) {
    console.log(`\n=== code=${combo.code} c=${combo.c} ===`)
    for (const prefix of ['01', '02']) {
      for (let n = 1; n <= 10; n++) {
        const s = prefix + String(n).padStart(2, '0')
        const r = await probe(combo.code, combo.c, s)
        if (r.ok) {
          console.log(`  HIT s=${s} → ${r.head.slice(0, 120)}`)
        }
      }
    }
  }
}
main().catch(e => console.error(e))
