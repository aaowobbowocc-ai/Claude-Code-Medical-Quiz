const https = require('https')
const pdfParse = require('pdf-parse')
const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

function fetch(url) {
  return new Promise(resolve => {
    https.get(url, {rejectUnauthorized:false, timeout:15000, headers:{'User-Agent':'Mozilla/5.0','Accept':'application/pdf,*/*'}}, res => {
      const ct = res.headers['content-type'] || ''
      if (res.statusCode !== 200 || !ct.includes('pdf')) { res.resume(); return resolve(null) }
      const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>resolve(Buffer.concat(chunks)))
    }).on('error',()=>resolve(null)).on('timeout',()=>resolve(null))
  })
}

async function probe(code, c, s) {
  const buf = await fetch(`${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`)
  if (!buf) return null
  try {
    const d = await pdfParse(buf)
    const text = d.text.replace(/\s+/g,' ').slice(0, 300)
    // Extract 類科/科目
    const classMatch = text.match(/類\s*科\s*名稱[：:]\s*([^\s科]+)/)
    const subjectMatch = text.match(/科\s*目\s*名稱[：:]\s*([^考]+?)(?:考試時間|$)/)
    return {
      cls: classMatch?.[1] || '?',
      subj: (subjectMatch?.[1] || '?').slice(0,50),
      raw: text.slice(0,120)
    }
  } catch { return {cls:'PDF', subj:'parse-fail'} }
}

;(async () => {
  // Probe code=110101, 110102, 110103 with all c/s combos
  const codes = ['110101','110102','110103']
  const cCodes = ['301','302','303','304','305','306','307','308','309','310','311','312','313','314']
  const sCodes = ['11','22','33','44','55','66','77']

  for (const code of codes) {
    console.log(`\n=== code=${code} ===`)
    for (const c of cCodes) {
      for (const s of sCodes) {
        const r = await probe(code, c, s)
        if (r) console.log(`  c=${c} s=${s}: [${r.cls}] ${r.subj}`)
      }
    }
  }
})()
