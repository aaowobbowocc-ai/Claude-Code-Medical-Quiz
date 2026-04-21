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
    const classMatch = text.match(/類\s*科\s*名稱[：:]\s*([^\s科]+)/)
    const subjectMatch = text.match(/科\s*目\s*名稱[：:]\s*([^考]+?)(?:考試時間|$)/)
    return { cls: classMatch?.[1] || '?', subj: (subjectMatch?.[1] || '?').slice(0,45) }
  } catch { return null }
}
;(async () => {
  // For each target exam, discover its subject codes (all s=XY where X=1-8, Y=1-8)
  const targets = [
    // 110 第二次 core exams
    {code:'110020', c:'302', label:'doctor2-110-1st'},
    {code:'110020', c:'304', label:'dental2-110-1st'},
    {code:'110020', c:'306', label:'pharma2-110-1st?'},
    {code:'110080', c:'302', label:'doctor2-110-2nd'},
    {code:'110080', c:'304', label:'dental2-110-2nd?'},
    {code:'110080', c:'306', label:'pharma2-110-2nd?'},
    {code:'110100', c:'304', label:'dental2-110-2nd'},
    {code:'110100', c:'306', label:'pharma2-110-2nd?'},
    {code:'110100', c:'308', label:'medlab-110-2nd'},
    {code:'110100', c:'312', label:'ot-110-2nd'},
    {code:'110101', c:'301', label:'doctor1-110-2nd'},
    {code:'110101', c:'303', label:'dental1-110-2nd'},
    {code:'110101', c:'305', label:'pharma1-110-2nd'},
    {code:'110101', c:'311', label:'pt-110-2nd'},
    {code:'110020', c:'308', label:'medlab-110-1st'},
    {code:'110020', c:'311', label:'pt-110-1st'},
  ]
  const sAll = []
  for (let p=1; p<=8; p++) for (let v=1; v<=9; v++) sAll.push(`${p}${v}`)

  for (const t of targets) {
    const subjects = []
    for (const s of sAll) {
      const r = await probe(t.code, t.c, s)
      if (r) subjects.push(`s=${s}[${r.subj}]`)
    }
    if (subjects.length === 0) {
      console.log(`\n${t.label} (${t.code}, c=${t.c}): NONE`)
    } else {
      console.log(`\n${t.label} (${t.code}, c=${t.c}): ${subjects.length} papers`)
      subjects.forEach(s => console.log('  '+s))
    }
  }
})()
