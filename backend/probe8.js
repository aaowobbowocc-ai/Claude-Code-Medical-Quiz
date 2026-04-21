// Precise probe for dental2/pharma2 across years (correct s codes)
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
  if (!buf) return false
  return true
}
;(async () => {
  // Test known-working s codes for each exam-c
  const targets = [
    {exam:'dental2', c:'304', s:'33'},
    {exam:'pharma2', c:'306', s:'44'},
    {exam:'doctor2', c:'302', s:'11'},
    {exam:'pharma1', c:'305', s:'33'},
  ]
  const codes = {
    '第一次': ['020'],
    '第二次': ['080','090','100']
  }
  for (const t of targets) {
    console.log(`\n--- ${t.exam} (c=${t.c}, s=${t.s}) ---`)
    for (const y of ['110','111','112','113','114','115']) {
      for (const [sess, sfxs] of Object.entries(codes)) {
        for (const sfx of sfxs) {
          const code = y + sfx
          const r = await probe(code, t.c, t.s)
          if (r) console.log(`  ${y} ${sess} ${code} ✓`)
        }
      }
    }
  }
})()
