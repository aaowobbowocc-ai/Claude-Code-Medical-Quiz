// Brute-force probe alternative (c, s) combos for targets that 302'd with the default URL.
// For each target's exam_code, enumerate candidate c values (and s variants), download PDFs,
// extract first-page text, match exam type + subject name against targets.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const fs = require('fs')
const path = require('path')
const https = require('https')
const vm = require('vm')
const pdfParse = require('pdf-parse')

const BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
const CACHE = path.join(__dirname, '..', '_tmp', 'alt-probe')
if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true })

// Load URL_LOOKUP
const scriptPath = path.join(__dirname, 'scrape-fill-gaps-vision.js')
let src = fs.readFileSync(scriptPath, 'utf8').replace(/main\(\)\.catch[^\n]*\n?/, '\n')
src += '\nglobal.__URL_LOOKUP__ = URL_LOOKUP\n'
const ctx = { require, module, exports, __dirname: path.dirname(scriptPath), __filename: scriptPath,
  console, process, Buffer, setTimeout, clearTimeout, global }
vm.createContext(ctx); vm.runInContext(src, ctx, { filename: scriptPath })
const URL_LOOKUP = ctx.global.__URL_LOOKUP__

// Parse gap targets
const lines = fs.readFileSync(path.join(__dirname, '..', 'gaps-dryrun.log'), 'utf8').split('\n')
const targets = []
for (const ln of lines) {
  const m = ln.match(/^  (\S+)\s+(\d+)年\s+(\d+)\s+"(.+?)"\s+—\s+缺(\d+)題:\s+(.+)$/)
  if (m) targets.push({ exam: m[1], year: m[2], code: m[3], subject: m[4], miss: parseInt(m[5]), qs: m[6] })
}

// Series classification by code suffix
function seriesOf(code) {
  const suf = code.slice(3) // e.g. '030', '020', '110', '140'
  if (['030','100','090','110','140','111','050','040','120','130'].includes(suf)) return suf
  return 'other'
}

// Candidate c values per series
function candidatesC(series) {
  if (['030','100','090','110','140','111'].includes(series)) {
    return Array.from({length:12},(_,i)=>String(101+i)) // 101..112
  }
  if (series === '020') {
    return ['301','302','303','304','305','306','307','308','309','310','311','312']
  }
  if (['050','040'].includes(series)) {
    return ['101','102','103','104','105','106']
  }
  if (['120','130'].includes(series)) {
    return ['101','102','103','104','105']
  }
  return ['101','102','103','104','105','106','107','108','109','110']
}

// Candidate s values: use the s from URL_LOOKUP entries matching this code (observed subject codes)
const sByCode = {}
for (const key of Object.keys(URL_LOOKUP)) {
  const [code, subject] = key.split('|')
  ;(sByCode[code] ||= new Set()).add(URL_LOOKUP[key].s)
}
// Extra typical s values per series
const extraS = {
  '030': ['0101','0102','0103','0104','0105','0106','0107','0108','0201','0202','0203','0204','0301','0302','0303','0304','0305','0306','0401','0402','0403','0404','0405','0406','0501','0502','0503','0504','0505','0506','0601','0602','0603','0604','0605','0606'],
  '100': ['0101','0102','0103','0104','0105','0106','0107','0108','0201','0202','0203','0204','0301','0302','0303','0304','0305','0401','0402','0403','0404','0501','0502','0503','0504','0601','0602','0603','0604'],
  '090': [], '110': [], '140': [], '111': [],
  '020': ['11','22','33','44','55','66','77','88'],
  '050': ['0101','0201','0301','0302','0303','0304','0305','0306','0307','0308','0309','0310','0311','0312','0401','0402','0501','0502','0601'],
  '040': ['0101','0201','0301','0302','0303','0304','0305','0306','0307','0308','0309','0310'],
  '130': ['0305','0306','0307','0308','0309','0310','0311','0312','0313','0314','0315','0316','0317','0412','0413','0414','0415','0420'],
  '120': ['0305','0306','0307','0308','0309','0310','0311','0312'],
}
function candidatesS(series, code) {
  const obs = sByCode[code] ? [...sByCode[code]] : []
  const extra = extraS[series] || []
  return [...new Set([...obs, ...extra])]
}

function fetchBytes(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) { res.resume(); return resolve({ ok: false, reason: 'redirect' }) }
      if (res.statusCode >= 400) { res.resume(); return resolve({ ok: false, reason: 'http'+res.statusCode }) }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        const ct = String(res.headers['content-type']||'')
        if (!/pdf/i.test(ct) || buf.length < 20000) return resolve({ ok: false, reason: 'not-pdf' })
        resolve({ ok: true, buf })
      })
    })
    req.on('error', e => resolve({ ok: false, reason: 'err:'+e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }) })
  })
}

async function identifyPdf(buf) {
  try {
    const { text } = await pdfParse(buf, { max: 1 })
    // Normalize: strip spaces around 類科/科別/科目/等別keywords (PDF uses 類 科/等 別 with spaces)
    const norm = text.replace(/\s+/g,' ')
    const lei = norm.match(/類\s*科\s*[：:]\s*([^ 　\n]+(?:[一二三四五六七八九十\d()（）]+)?(?:一階|二階)?)/)
    const koe = norm.match(/科\s*目\s*[：:]\s*([^ 　\n]+?)(?=\s*(?:考試時間|科  目|第\s*\d+|１\.|1\.|\(|（))/)
    const eta = norm.match(/考\s*試\s*別\s*[：:]\s*([^ 　\n]+)/)
    const firstLines = text.split('\n').slice(0,5).map(s=>s.trim()).filter(Boolean).join(' | ')
    return { leiKo: lei?lei[1].trim():'', subj: koe?koe[1].trim():'', examType: eta?eta[1].trim():'', head: firstLines }
  } catch (e) { return { leiKo:'', subj:'', examType:'', head:'(parse-fail:'+e.message+')' } }
}

const EXAM_TO_LEIKO = {
  nursing: ['護理師'],
  nutrition: ['營養師'],
  'social-worker': ['社會工作師'],
  tcm1: ['中醫師(一)','中醫師一階','中醫師'],
  tcm2: ['中醫師(二)','中醫師二階','中醫師'],
  doctor2: ['醫師(二)','醫師二階','醫師'],
  pharma1: ['藥師(一)','藥師一階','藥師'],
  pharma2: ['藥師(二)','藥師二階','藥師'],
  medlab: ['醫事檢驗師'],
  radiology: ['醫事放射師'],
  customs: [], // match by examType instead
  judicial: [],
  police: [],
  pt: ['物理治療師'],
  ot: ['職能治療師'],
  vet: ['獸醫師'],
  dental1: ['牙醫師(一)','牙醫師一階','牙醫師'],
  dental2: ['牙醫師(二)','牙醫師二階','牙醫師'],
  doctor1: ['醫師(一)','醫師一階','醫師'],
}

function matches(target, info) {
  if (!info || !info.subj) return false
  // Subject match: strict equality after normalization
  const norm = s => (s||'').replace(/[()（）\s　]/g,'')
  if (norm(info.subj) !== norm(target.subject)) return false
  // Exam-type match
  const leikoCands = EXAM_TO_LEIKO[target.exam] || []
  if (leikoCands.length) {
    const ok = leikoCands.some(k => norm(info.leiKo) === norm(k) || norm(info.leiKo).includes(norm(k)))
    if (!ok) return false
  }
  return true
}

// Targets that failed with URL_LOOKUP's default URL — we re-probe only those.
// Loose definition: everything in the gap list; the ones with good URLs will still be fine
// (we can cross-reference against prior probe results, but it's simpler to just re-try all).
const failed = targets.filter(t => URL_LOOKUP[`${t.code}|${t.subject}`])

// Unique (code) set to probe
const codes = [...new Set(failed.map(t=>t.code))]
console.error(`Probing ${codes.length} unique codes for ${failed.length} failed targets`)

async function probeCode(code) {
  const series = seriesOf(code)
  const cs = candidatesC(series)
  const ss = candidatesS(series, code)
  const results = [] // { c, s, firstLine }
  // Limit combinations: if ss empty, skip
  if (!ss.length) return results
  const combos = []
  for (const c of cs) for (const s of ss) combos.push({ c, s })
  // Concurrent probes within a code
  const CONC = 8
  let idx = 0
  async function worker() {
    while (true) {
      const my = idx++
      if (my >= combos.length) return
      const { c, s } = combos[my]
      const url = `${BASE}?t=Q&code=${code}&c=${c}&s=${s}&q=1`
      const cacheFile = path.join(CACHE, `${code}_${c}_${s}.pdf`)
      let buf
      if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 20000) {
        buf = fs.readFileSync(cacheFile)
      } else {
        const r = await fetchBytes(url)
        if (!r.ok) continue
        buf = r.buf
        try { fs.writeFileSync(cacheFile, buf) } catch {}
      }
      const info = await identifyPdf(buf)
      results.push({ c, s, info })
    }
  }
  await Promise.all(Array.from({length:CONC},worker))
  return results
}

async function run() {
  const byCode = {} // code -> [{c,s,firstLine}]
  let doneCodes = 0
  for (const code of codes) {
    byCode[code] = await probeCode(code)
    doneCodes++
    console.error(`  ${doneCodes}/${codes.length} ${code}: ${byCode[code].length} valid PDFs`)
  }
  // Match targets to findings
  const matched = [], unmatched = []
  for (const t of failed) {
    const found = byCode[t.code] || []
    const hit = found.find(r => matches(t, r.info))
    if (hit) matched.push({ ...t, hit })
    else unmatched.push(t)
  }
  console.log(`\n配對成功: ${matched.length} / ${failed.length}`)
  console.log(`未配對: ${unmatched.length}`)
  // Report
  const out = []
  out.push('# 暴力探測結果（alt c/s）')
  out.push('')
  out.push(`掃 ${codes.length} 個 exam_code，找到新 URL ${matched.length} 筆`)
  out.push('')
  if (matched.length) {
    out.push('## ✅ 新找到的 URL（建議加入 URL_LOOKUP 後重跑 fill-gaps）')
    out.push('')
    out.push('| 考試 | 年 | 場次 | 科目 | 舊 c/s | 新 c/s | 缺 | 類科 | 科目(驗證) |')
    out.push('|---|---|---|---|---|---|---|---|---|')
    for (const m of matched) {
      const old = URL_LOOKUP[`${m.code}|${m.subject}`]
      out.push(`| ${m.exam} | ${m.year} | ${m.code} | ${m.subject} | c=${old.c} s=${old.s} | **c=${m.hit.c} s=${m.hit.s}** | ${m.miss} | ${m.hit.info.leiKo} | ${m.hit.info.subj} |`)
    }
  }
  out.push('')
  out.push('## ❌ 真的找不到（所有 c/s 組合都 302 或 PDF 內容不含該科目）')
  out.push('')
  out.push('| 考試 | 年 | 場次 | 科目 | 缺 |')
  out.push('|---|---|---|---|---|')
  for (const t of unmatched) out.push(`| ${t.exam} | ${t.year} | ${t.code} | ${t.subject} | ${t.miss} |`)
  fs.writeFileSync(path.join(__dirname,'..','ALT-PROBE-RESULT.md'), out.join('\n'))
  fs.writeFileSync(path.join(__dirname,'..','alt-probe-matches.json'),
    JSON.stringify(matched.map(m => ({
      exam: m.exam, code: m.code, subject: m.subject, miss: m.miss,
      oldC: URL_LOOKUP[`${m.code}|${m.subject}`].c, oldS: URL_LOOKUP[`${m.code}|${m.subject}`].s,
      newC: m.hit.c, newS: m.hit.s,
    })), null, 2))
  console.log('Wrote ALT-PROBE-RESULT.md + alt-probe-matches.json')
}
run()
