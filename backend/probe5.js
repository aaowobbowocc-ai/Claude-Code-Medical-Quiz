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
    return { title: (titleMatch?.[1] || '?').slice(0,45), cls: classMatch?.[1] || '?' }
  } catch { return null }
}
;(async () => {
  // Completeness check for 110 第二次 range + 110020 (110 第一次) with ALL c values and s=11,22,33,44,55
  const codes = ['110020','110030','110080','110100','110101','110102','110103']
  const cCodes = []
  for (let i = 100; i < 120; i++) cCodes.push(i.toString().padStart(3,'0'))
  for (let i = 300; i < 320; i++) cCodes.push(i.toString())

  for (const code of codes) {
    console.log(`\n=== code=${code} ===`)
    for (const c of cCodes) {
      for (const s of ['11','22','33']) {
        const r = await probe(code, c, s)
        if (r) {
          console.log(`  c=${c} s=${s}: [${r.cls}] ${r.title}`)
          break // Only need 1 per c to confirm existence
        }
      }
    }
  }

  // Separately test 111/112/113 第一次 in OLD format for medlab/pt/ot
  console.log('\n\n--- OLD system for 111-113 (medlab/pt/ot/nursing/nutrition) ---')
  for (const code of ['111020','112020','113020','111100','112100','113100','113090']) {
    console.log(`\n${code}:`)
    for (const c of ['101','102','308','311','312']) {
      const r = await probe(code, c, '11')
      if (r) console.log(`  c=${c}: [${r.cls}] ${r.title}`)
    }
  }
})()
