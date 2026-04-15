process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const https = require('https')
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'

function headPdf(url) {
  return new Promise(resolve => {
    https.get(url, { rejectUnauthorized: false, timeout: 15000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*', Referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' } },
      res => {
        if (res.statusCode === 302 || res.statusCode === 301) { res.resume(); return resolve({ ok: false, reason: '302' }) }
        if (res.statusCode !== 200) { res.resume(); return resolve({ ok: false, reason: 'HTTP ' + res.statusCode }) }
        const ct = res.headers['content-type'] || ''
        const cl = res.headers['content-length'] || '?'
        res.resume()
        if (!ct.includes('pdf') && !ct.includes('octet')) return resolve({ ok: false, reason: 'ct=' + ct })
        resolve({ ok: true, bytes: cl })
      }).on('error', e => resolve({ ok: false, reason: e.message.slice(0, 30) }))
       .on('timeout', function () { this.destroy(); resolve({ ok: false, reason: 'timeout' }) })
  })
}

async function probe(label, code, c, s) {
  const url = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
  const r = await headPdf(url)
  console.log(`  [${r.ok ? 'OK' : '--'}] c=${c} code=${code} s=${s.toString().padEnd(4)} ${r.ok ? r.bytes + 'B' : r.reason}`)
  return r.ok
}

async function main() {
  console.log('TCM 115-1 — try all (classCode × s-code) combinations')
  // tcm1: 317 | tcm2: 318 | tcm1 old: 101 | tcm2 old: 102
  // s codes: 2-digit (11, 22, 33, 44) and 4-digit (0201, 0202...)
  for (const code of ['115020', '115010', '115030']) {
    for (const c of ['317', '318']) {
      for (const s of ['11', '22', '0201', '0202']) {
        const ok = await probe(`c${c} s${s}`, code, c, s)
        if (ok) break
      }
    }
  }
  // Try with older class codes 101/102 too
  console.log('\nWith old class codes 101/102 (unlikely but check):')
  for (const code of ['115020']) {
    for (const c of ['101', '102']) {
      for (const s of ['11', '22', '0201']) {
        await probe(`c${c} s${s}`, code, c, s)
      }
    }
  }
}
main()
