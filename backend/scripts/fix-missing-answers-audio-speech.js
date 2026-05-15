#!/usr/bin/env node
// Parse A_ PDFs (both tabular formats) and fill missing answers
const fs = require('fs')
const path = require('path')
const PDF_CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')

let mupdfMod
async function getMupdf() { if (!mupdfMod) mupdfMod = await import('mupdf'); return mupdfMod }
async function readText(buf) {
  const mupdf = await getMupdf()
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  let txt = ''
  for (let i = 0; i < doc.countPages(); i++) txt += doc.loadPage(i).toStructuredText('preserve-whitespace').asText()
  return txt.normalize('NFKC')
}

// Parse: extract all standalone A-D letters after first "答案" marker.
// Tabular PDFs put each answer on its own line; we just collect them in order.
function parseAnswers(txt) {
  // Strip headers ("題號"/"答案"/"代號") and other noise; keep only single letters
  // Find first "標準答案" or "答案" header
  const startMatch = txt.match(/(標準答案|答案)\s*[:：]?/)
  if (!startMatch) return []
  const start = txt.indexOf(startMatch[0]) + startMatch[0].length
  const body = txt.slice(start)
  // 取單一字母行：line content is exactly A/B/C/D/# after trim
  const lines = body.split(/\n+/)
  const answers = []
  for (const line of lines) {
    const t = line.trim()
    if (/^[A-D]$/.test(t)) answers.push(t)
    else if (/^[ＡＢＣＤ]$/.test(t)) answers.push(t.replace(/Ａ/,'A').replace(/Ｂ/,'B').replace(/Ｃ/,'C').replace(/Ｄ/,'D'))
    else if (t === '#' || t === '＃') answers.push('#')
  }
  return answers
}

const AUDIO_S = {
  '基礎聽力科學': 's0901',
  '行為聽力學': 's0902',
  '電生理聽力學': 's0903',
  '聽覺輔具原理與實務學': 's0904',
  '聽覺與平衡系統之創健與復健學': 's0905',
  '聽語溝通障礙學（包括專業倫理）': 's0906',
}
// Modern (107110+) → tail 1-6 in s1001-s1006
// Old years (100-101) use different subject order; the "tail digit" is what we
// rely on for PDF lookup. Old PDFs subject mapping (verified by probing):
//   s_X_01=基礎言語科學, _02=神經性溝通, _03=兒童語言, _04=嗓音吞嚥, _05=構音語暢, _06=溝通障礙總論
// Modern data subjects → tail:
const SPEECH_S = {
  '基礎言語科學': 's1001',
  '神經性溝通障礙學': 's1002',
  '兒童語言障礙': 's1003',
  '嗓音與吞嚥障礙': 's1004',
  '構音與語暢障礙': 's1005',
  '聽力學與輔助溝通系統（包括專業倫理）': 's1006', // maps to 溝通障礙總論 in old PDFs
}
const AUDIO_C = {
  '100090': '301', '100140': '112', '101070': '301', '101110': '112',
  '102030': '112', '102110': '201', '103100': '113', '104100': '110', '106110': '110',
}
const SPEECH_C = {
  '100090': '201', '100140': '111', '101070': '201', '101110': '111',
  '102030': '114', '102110': '114', '103100': '112', '104100': '109',
  '105090': '109', '106110': '109', '107110': '109',
}

// For old years (100090-102110), s_code may use 0401-0406 etc.
// Probe by listing actual cached files
function findAnswerPdf(prefix, code, c, sBase) {
  // Try base, then year-specific alternates
  const candidates = [sBase]
  // Try s04xx-s10xx variants (different prefixes per year, same tail digit 1-6)
  const tail = sBase.slice(-1)
  for (const p of ['04','05','06','07','08','09','10']) {
    candidates.push(`s${p}0${tail}`)
  }
  for (const s of candidates) {
    const fp = path.join(PDF_CACHE, `A_${prefix}_${code}_c${c}_${s}.pdf`)
    if (fs.existsSync(fp)) return { path: fp, sCode: s }
  }
  return null
}

async function fix(filePath, sMap, cMap, prefix) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  const arr = data.questions || data
  const targets = {}
  for (const q of arr) {
    if (q.answer && String(q.answer).trim()) continue
    const key = `${q.exam_code}|${q.subject}`
    if (!targets[key]) targets[key] = []
    targets[key].push(q)
  }
  console.log(filePath, 'groups:', Object.keys(targets).length)
  let totalFixed = 0
  for (const [key, qs] of Object.entries(targets)) {
    const [code, subject] = key.split('|')
    const c = cMap[code]
    const sBase = sMap[subject]
    if (!c || !sBase) { console.log('  skip', key, 'no c/s'); continue }
    const found = findAnswerPdf(prefix, code, c, sBase)
    if (!found) { console.log('  no PDF', key, 'tried s candidates'); continue }
    try {
      const txt = await readText(fs.readFileSync(found.path))
      const ans = parseAnswers(txt)
      if (ans.length < 20) { console.log('  too few ans', key, 'got', ans.length, 'from', found.sCode); continue }
      let groupFixed = 0
      for (const q of qs) {
        const a = ans[q.number - 1]
        if (!a || a === '#') continue
        q.answer = a
        groupFixed++
        totalFixed++
      }
      console.log('  ', key, '→', groupFixed, '/', qs.length, '(' + found.sCode + ', total ans=' + ans.length + ')')
    } catch (e) { console.log('  ERR', key, e.message) }
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
  console.log(filePath, ': fixed', totalFixed)
  return totalFixed
}

async function main() {
  const a = await fix('questions-audiologist.json', AUDIO_S, AUDIO_C, 'audiologist')
  const s = await fix('questions-speech-therapist.json', SPEECH_S, SPEECH_C, 'speech-therapist')
  console.log('\nGRAND TOTAL:', a + s)
}
main().catch(e => { console.error(e); process.exit(1) })
