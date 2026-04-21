#!/usr/bin/env node
const https = require('https')
const pdfParse = require('pdf-parse')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

function fetch(code, c, s) {
  return new Promise((resolve, reject) => {
    https.get(`${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`, {
      rejectUnauthorized: false, timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/pdf,*/*', 'Referer': 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${res.statusCode}`)) }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    }).on('error', reject)
  })
}

async function head(code, c, s) {
  try {
    const buf = await fetch(code, c, s)
    const t = (await pdfParse(buf)).text.slice(0, 300).replace(/\s+/g, ' ').trim()
    const year = (t.match(/(\d{3})年/) || [])[1] || ''
    const sess = (t.match(/第[一二三四五]次/) || [])[0] || ''
    const cls = (t.match(/類\s*科[：:]\s*([^\s]+)/) || [])[1] || ''
    const sub = (t.match(/科\s*目[：:]\s*([^（\s]+)/) || [])[1] || ''
    const is申論 = t.includes('申論題部分') ? '[申論]' : ''
    const qCount = (t.match(/本科目共\s*(\d+)\s*題/) || [])[1] || ''
    return `${year}${sess} ${cls} / ${sub} ${qCount}題 ${is申論}`.trim()
  } catch (e) { return `✗ ${e.message}` }
}

async function main() {
  // Confirm 112 第一次 & 113 第一次 nursing: what code?
  console.log('=== nursing 112/113 第一次 search ===')
  for (const y of ['112','113']) {
    for (const suffix of ['020','030','040','050','060','070','080']) {
      for (const c of ['101','102','103','104','105']) {
        for (const s of ['0101','0301','0303']) {
          const r = await head(y + suffix, c, s)
          if (!r.includes('✗') && r.includes('護理師')) console.log(`  ${y}${suffix} c=${c} s=${s}: ${r}`)
        }
      }
    }
  }

  // 180 series: check 0104/0105/0106 + search for other years
  console.log('\n=== nursing 180 suffix — complete 0104/0105/0106 check ===')
  for (const y of ['110','111','112','113','114','115']) {
    for (const s of ['0104','0105','0106']) {
      const r = await head(y + '180', '101', s)
      if (!r.includes('✗')) console.log(`  ${y}180 c=101 s=${s}: ${r}`)
    }
  }

  // Other 180 variants
  console.log('\n=== 180 variants for other nursing class codes ===')
  for (const y of ['110','111','112','113']) {
    for (const c of ['102','103','104','105']) {
      for (const s of ['0101','0102','0103','0104','0105']) {
        const r = await head(y + '180', c, s)
        if (!r.includes('✗') && r.includes('護理師')) console.log(`  ${y}180 c=${c} s=${s}: ${r}`)
      }
    }
  }

  // Nursing 112/113 can also try 181/182
  console.log('\n=== nursing 181/182 ===')
  for (const y of ['110','111','112','113']) {
    for (const suffix of ['181','182','170','171']) {
      for (const c of ['101','104']) {
        for (const s of ['0101','0301']) {
          const r = await head(y + suffix, c, s)
          if (!r.includes('✗') && r.includes('護理師')) console.log(`  ${y}${suffix} c=${c} s=${s}: ${r}`)
        }
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
