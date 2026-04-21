// Discover all valid exam codes in 110 (old system) range
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
    const text = d.text.replace(/\s+/g,' ').slice(0, 400)
    const titleMatch = text.match(/(\d{3}年.*?)\s*代\s*號/)
    const classMatch = text.match(/類\s*科\s*名稱[：:]\s*([^\s科]+)/)
    const subjectMatch = text.match(/科\s*目\s*名稱[：:]\s*([^考]+?)(?:考試時間|$)/)
    return {
      title: titleMatch?.[1] || '?',
      cls: classMatch?.[1] || '?',
      subj: (subjectMatch?.[1] || '?').slice(0,60),
    }
  } catch { return {title:'pdf',cls:'?',subj:'parse-fail'} }
}

;(async () => {
  // Wide probe: various 110 codes with various c values
  const codes = ['110020','110030','110040','110050','110060','110070','110080','110090','110100','110101','110102','110103','110104','110110','110200','110300','110400','110500','110600','110700','110800','110900']
  const seen = new Set()
  for (const code of codes) {
    // Test one c value to see if code exists
    let found = false
    for (const c of ['101','102','301','303','305','308','311','312']) {
      const r = await probe(code, c, '11')
      if (!r) continue
      if (!found) { console.log(`\n=== code=${code} ===`); found = true }
      const key = `${code}|${c}`
      if (seen.has(key)) continue
      seen.add(key)
      console.log(`  c=${c} s=11: ${r.title.slice(0,60)} [${r.cls}] ${r.subj.slice(0,40)}`)
    }
  }
})()
