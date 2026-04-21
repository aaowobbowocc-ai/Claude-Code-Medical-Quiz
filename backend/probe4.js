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
    const text = d.text.replace(/\s+/g,' ').slice(0, 350)
    const titleMatch = text.match(/(\d{3}年[^代]*?)\s*代\s*號/)
    const classMatch = text.match(/類\s*科\s*名稱[：:]\s*([^\s科]+)/)
    const subjectMatch = text.match(/科\s*目\s*名稱[：:]\s*([^考]+?)(?:考試時間|$)/)
    return { title: (titleMatch?.[1] || '?').slice(0,50), cls: classMatch?.[1] || '?', subj: (subjectMatch?.[1] || '?').slice(0,55) }
  } catch { return null }
}
;(async () => {
  // Probe stage-2 + new exam codes around 110100-110115
  const codes = []
  for (let n = 100; n <= 115; n++) codes.push(`110${n.toString().padStart(3,'0')}`)
  // Also add nursing/nutrition candidates
  codes.push('110030','110031','110032','110050','110051','110060','110061','110070','110080','110200','110210')

  const cCodes = ['101','102','103','104','105','106','107','108','301','302','303','304','305','306','307','308','309','310','311','312','313','314','315','316']
  for (const code of codes) {
    let found = false
    for (const c of cCodes) {
      const r = await probe(code, c, '11')
      if (!r) continue
      if (!found) { console.log(`\n=== code=${code} ===`); found = true }
      console.log(`  c=${c}: ${r.title.slice(0,40)} [${r.cls}] ${r.subj.slice(0,40)}`)
    }
  }
})()
