// Probe missing second sessions for years 100-105
const https = require('https')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

function probe(code, c, s) {
  const url = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
  return new Promise(resolve => {
    const req = https.get(url, {
      rejectUnauthorized: false, timeout: 12000,
      headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*',
                 Referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, res => {
      if (res.statusCode === 302) {
        const loc = res.headers.location || ''
        res.resume()
        if (!loc.startsWith('http')) return resolve('404')
        return resolve('302:' + loc.slice(0, 40))
      }
      if (res.statusCode === 200) {
        let bytes = 0
        res.on('data', c => { bytes += c.length; if (bytes > 100) req.destroy() })
        res.on('end', () => resolve('OK'))
        res.on('close', () => resolve('OK'))
      } else {
        res.resume(); resolve('HTTP' + res.statusCode)
      }
    })
    req.on('error', e => resolve('ERR:' + e.code))
    req.on('timeout', () => { req.destroy(); resolve('TIMEOUT') })
  })
}

async function check(label, code, c, s) {
  const r = await probe(code, c, s)
  const ok = r === 'OK'
  if (ok) console.log(`✅ ${label}`)
  else if (r !== '404') console.log(`⚠️  ${label} → ${r}`)
  return ok
}

async function batch(items, concurrency = 4) {
  const found = []
  for (let i = 0; i < items.length; i += concurrency) {
    const slice = items.slice(i, i + concurrency)
    const results = await Promise.all(slice.map(([label, code, c, s]) => check(label, code, c, s).then(ok => ok ? [label, code, c, s] : null)))
    found.push(...results.filter(Boolean))
  }
  return found
}

async function main() {
  const items = []

  // 020 series: year 100 second session (code unknown)
  for (const code of ['100080', '100090', '100100', '100110']) {
    items.push([`dental1 100-2 ${code} c=301 s=11`, code, 301, 11])
    items.push([`dental2 100-2 ${code} c=302 s=11`, code, 302, 11])
    items.push([`doctor2 100-2 ${code} c=302 s=11`, code, 302, 11])
    items.push([`ot     100-2 ${code} c=305 s=11`,  code, 305, 11])
    items.push([`pt     100-2 ${code} c=309 s=11`,  code, 309, 11])
    items.push([`radio  100-2 ${code} c=308 s=11`,  code, 308, 11])
  }

  // doctor2 101-102 second session
  items.push([`doctor2 101-2 101100 c=102 s=11`, '101100', 102, 11])
  items.push([`doctor2 102-2 102100 c=102 s=11`, '102100', 102, 11])
  items.push([`doctor2 101-2 101100 c=103 s=11`, '101100', 103, 11])

  // medlab 100-101 second session
  items.push([`medlab 100-2 100100 c=311 s=11`,    '100100', 311, 11])
  items.push([`medlab 101-2 101100 c=311 s=11`,    '101100', 311, 11])
  items.push([`medlab 100-2 100100 c=104 s=0107`,  '100100', 104, '0107'])
  items.push([`medlab 100-2 100090 c=104 s=0107`,  '100090', 104, '0107'])

  // dental1 104 second session
  for (const c of [301, 303, 304, 306]) {
    items.push([`dental1 104-2 104090 c=${c} s=11`, '104090', c, 11])
  }

  // ot 104 second session
  for (const c of [305, 306, 312]) {
    items.push([`ot 104-2 104090 c=${c} s=11`, '104090', c, 11])
  }

  // 030 series: nursing 100-102 second sessions
  for (const [yr, codes] of [['100', ['100090','100100']], ['101', ['101100']], ['102', ['102100','102110']]]) {
    for (const code of codes) {
      for (const c of [105, 106, 107]) {
        items.push([`nursing ${yr}-2 ${code} c=${c} s=0101`, code, c, '0101'])
      }
    }
  }

  // 030 series: tcm1/tcm2 100-103 second sessions
  for (const [yr, codes] of [['100',['100090','100100']],['101',['101100']],['102',['102100']],['103',['103090','103100']]]) {
    for (const code of codes) {
      for (const c of [101, 106, 107]) {
        items.push([`tcm1 ${yr}-2 ${code} c=${c} s=0101`, code, c, '0101'])
        items.push([`tcm2 ${yr}-2 ${code} c=${c} s=0201`, code, c, '0201'])
      }
    }
  }

  // pharma 100-101 second sessions (030 series)
  for (const code of ['100090', '100100']) {
    items.push([`pharma1 100-2 ${code} c=103 s=0201`, code, 103, '0201'])
    items.push([`pharma2 100-2 ${code} c=103 s=0301`, code, 103, '0301'])
  }
  items.push([`pharma1 101-2 101100 c=103 s=0201`, '101100', 103, '0201'])
  items.push([`pharma2 101-2 101100 c=103 s=0301`, '101100', 103, '0301'])

  // nutrition 101 second session
  items.push([`nutrition 101-2 101100 c=107 s=0101`, '101100', 107, '0101'])

  console.log(`Probing ${items.length} URLs (concurrency=4)...\n`)
  const found = await batch(items, 4)

  console.log(`\n=== 找到 ${found.length} 個有效 URL ===`)
  if (found.length === 0) {
    console.log('全部 404 — 這些年度可能從未有第二次考試，或資料不在線上系統。')
  }
}

main().catch(console.error)
