#!/usr/bin/env node
/** 補測 RT 早年第一次場次（101010）與 104 年第二次（104090/100/110）。 */
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

async function checkPdf(buf) {
  try {
    const mupdf = await import('mupdf')
    const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
    return doc.loadPage(0).toStructuredText('preserve-whitespace').asText().normalize('NFKC')
  } catch { return '' }
}

async function check(code, c, s) {
  const buf = await get(`${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`)
  if (!buf || buf.length < 5000) return null
  const txt = await checkPdf(buf)
  if (!txt.includes('呼吸治療')) return null
  const subj = txt.match(/科\s*目[：:]?\s*([^\s\n（(]+)/)?.[1] || ''
  return subj
}

async function main() {
  const sessions = ['101010', '104090', '104100', '104110', '105020', '105100', '105090']
  for (const code of sessions) {
    let any = false
    for (const s of ['11','22','33','44','55','66']) {
      const subj = await check(code, '306', s)
      if (subj) { console.log(`✓ ${code} c=306 s=${s} → ${subj}`); any = true }
      await new Promise(r => setTimeout(r, 150))
    }
    if (!any) console.log(`✗ ${code}: 無 RT PDF`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
