// Final probe: find the exact codes for medlab/pt/ot 111-113 第二次, and nursing/nutrition 110-113
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
    const text = d.text.replace(/\s+/g,' ').slice(0, 250)
    const titleMatch = text.match(/(\d{3}年[^代]*?)\s*代\s*號/)
    const classMatch = text.match(/類\s*科\s*名稱[：:]\s*([^\s科]+)/)
    return { title: (titleMatch?.[1] || '?').slice(0,45), cls: classMatch?.[1] || '?' }
  } catch { return null }
}
;(async () => {
  // For each year 110-115, try both 第一次 (XX020) and 第二次 (multiple candidates)
  const years = ['110','111','112','113','114','115']
  const sessionCodes = {
    '第一次': ['020'],
    '第二次': ['080','090','100','101']
  }
  const targets = [
    {exam:'medlab', c:'308'},
    {exam:'pt', c:'311'},
    {exam:'ot', c:'312'},
    {exam:'nursing', c:'101'},
    {exam:'nutrition', c:'102'},
    {exam:'doctor1', c:'301'},
    {exam:'doctor2', c:'302'},
    {exam:'dental1', c:'303'},
    {exam:'dental2', c:'304'},
    {exam:'pharma1', c:'305'},
    {exam:'pharma2', c:'306'},
  ]
  console.log('Mapping existing exam sessions (OLD system):')
  console.log('exam     year session code   c   status')
  for (const t of targets) {
    for (const y of years) {
      for (const [sess, suffixes] of Object.entries(sessionCodes)) {
        for (const sfx of suffixes) {
          const code = y + sfx
          const r = await probe(code, t.c, t.c.startsWith('3')&&['305','306'].includes(t.c)?'33':(t.c==='101'||t.c==='102'?'11':'11'))
          if (r) {
            console.log(`${t.exam.padEnd(9)} ${y}  ${sess}  ${code} c=${t.c}  [${r.cls}] ${r.title.slice(0,25)}`)
          }
        }
      }
    }
  }
})()
