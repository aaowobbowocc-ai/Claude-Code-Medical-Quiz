#!/usr/bin/env node
/**
 * Probe MoEX for missing 公職/司法/律師 PDFs.
 *
 * For each (exam, year) combo not yet in our DB, try common code/c/s patterns
 * with content verification (PDF first-page must contain expected exam name).
 *
 * Output: list of confirmed working URLs to feed into rescrape pipeline.
 */

require('dotenv/config')
const https = require('https')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

function get(url) {
  return new Promise((res) => {
    const agent = new https.Agent({ rejectUnauthorized: false })
    https.get(url, { agent }, r => {
      if (r.statusCode !== 200) { r.destroy(); return res(null) }
      const ch = []
      r.on('data', c => ch.push(c))
      r.on('end', () => res(Buffer.concat(ch)))
    }).on('error', () => res(null))
  })
}

const STRIP = (s) => s.normalize('NFKC').replace(/[-]/g, '')

async function checkPdf(buf, expectKlass) {
  const mupdf = await import('mupdf')
  try {
    const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
    const text = STRIP(doc.loadPage(0).toStructuredText('preserve-whitespace').asText())
    const klassMatch = text.match(/類\s*科[：:]?\s*([^\s\n]+)/)?.[1] || ''
    const subjMatch  = text.match(/科\s*目[：:]?\s*([^\s\n（(]+)/)?.[1] || ''
    if (!klassMatch) return null
    if (Array.isArray(expectKlass)) {
      if (!expectKlass.some(k => klassMatch.includes(k))) return null
    } else if (!klassMatch.includes(expectKlass)) {
      return null
    }
    return { klass: klassMatch, subject: subjMatch }
  } catch { return null }
}

async function probe(exam, code, c, s, expectKlass) {
  const buf = await get(`${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`)
  if (!buf || buf.length < 5000) return null
  const meta = await checkPdf(buf, expectKlass)
  if (!meta) return null
  console.log(`✓ ${exam} code=${code} c=${c} s=${s} → 類科:${meta.klass} 科目:${meta.subject}`)
  return { code, c, s, ...meta }
}

const TARGETS = [
  // civil-senior 高考三等：106 起。105/104/103... 可能不存在但試一下
  // pattern observed: 106-112 → YYY090; 113-114 → YYY080
  { exam: 'civil-senior', expectKlass: ['一般行政','人事行政','財稅行政'],
    years: [100,101,102,103,104,105,115],
    codes: y => [`${y}090`, `${y}080`, `${y}100`, `${y}030`],
    cs: ['101','102','103','104','105'],
    ss: ['0301','0302','0303','0304','0401'] },

  // police 三等 + police4 四等: 108 起。105-107 可能存在
  // pattern: 108-112 → 070; 113-114 → 060
  { exam: 'police', expectKlass: ['一般警察人員','警察特考'],
    years: [105,106,107,115],
    codes: y => [`${y}070`, `${y}060`, `${y}080`, `${y}100`],
    cs: ['101','102','103','104','105','106'],
    ss: ['0101','0102','0201','0202','0301','0302'] },

  // judicial 司法特考三等：106 起。105 試
  { exam: 'judicial', expectKlass: '司法',
    years: [100,101,102,103,104,105,115],
    codes: y => [`${y}130`, `${y}120`, `${y}080`, `${y}030`],
    cs: ['101','102','103','104'],
    ss: ['0301','0302','0303','0304'] },

  // customs 關務特考：108 起。105-107 可能存在
  { exam: 'customs', expectKlass: '關務',
    years: [100,101,102,103,104,105,106,107],
    codes: y => [`${y}050`, `${y}060`, `${y}040`, `${y}030`],
    cs: ['101','102','103'],
    ss: ['0301','0302','0303','0304','0401'] },

  // lawyer1 律師一試：105 起。100-104 試
  { exam: 'lawyer1', expectKlass: '律師',
    years: [100,101,102,103,104,115],
    codes: y => [`${y}110`, `${y}120`, `${y}030`, `${y}040`],
    cs: ['101','102'],
    ss: ['0101','0102','0201','0202','0301','0302','0401','0402'] },
]

async function main() {
  const found = []
  for (const t of TARGETS) {
    console.log(`\n=== ${t.exam} ===`)
    for (const y of t.years) {
      const codes = t.codes(y)
      for (const code of codes) {
        for (const c of t.cs) {
          for (const s of t.ss) {
            const r = await probe(t.exam, code, c, s, t.expectKlass)
            if (r) found.push({ exam: t.exam, year: y, ...r })
            await new Promise(rs => setTimeout(rs, 60))  // gentle rate limit
          }
        }
      }
    }
  }
  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(found, null, 2))
}

main().catch(e => console.error(e))
