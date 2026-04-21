// Probe old system: download PDFs and read first line to identify exam/subject
const https = require('https')
const pdfParse = require('pdf-parse')
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

function fetch(url) {
  return new Promise(resolve => {
    https.get(url, {rejectUnauthorized:false, timeout:15000, headers:{'User-Agent':'Mozilla/5.0','Accept':'application/pdf,*/*'}}, res => {
      const ct = res.headers['content-type'] || ''
      if (res.statusCode !== 200 || !ct.includes('pdf')) { res.resume(); return resolve({ok:false, status:res.statusCode}) }
      const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>resolve({ok:true, buf:Buffer.concat(chunks)}))
    }).on('error',()=>resolve({ok:false})).on('timeout',()=>resolve({ok:false, timeout:true}))
  })
}

async function identify(code, c, s) {
  const url = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
  const r = await fetch(url)
  if (!r.ok) return null
  try {
    const d = await pdfParse(r.buf)
    // First 300 chars
    const head = d.text.replace(/\s+/g, ' ').trim().slice(0, 250)
    return head
  } catch { return 'PDF (parse failed)' }
}

;(async () => {
  console.log('=== Systematic probe: code=110101, all c × all s ===')
  // Try all reasonable c and s combos
  const cCodes = ['301','302','303','304','305','306','307','308','309','310']
  const sCodes = ['11','12','13','14','15','16','17','21','22','23','24','31','32','33','41','42','43','51','61','71','81']

  for (const c of cCodes) {
    for (const s of sCodes) {
      const info = await identify('110101', c, s)
      if (info) {
        console.log(`  c=${c} s=${s}:`)
        console.log(`    ${info.slice(0,150)}`)
      }
    }
  }
})()
