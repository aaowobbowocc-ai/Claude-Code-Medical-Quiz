#!/usr/bin/env node
// 牙體技術師爬蟲。每卷 = 申論題（跳過）+ 乙、測驗題部分（單選 40 題，無 ABCD 標記
// 雙欄格式）。用 column parser 解析測驗題；答案 PDF 連續字串或網格式。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')
const { fetchPdf, buildMoexUrl } = require('./lib/pdf-fetcher')
const { parseColumnAware, parseAnswersColumnAware } = require('./lib/moex-column-parser')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')
const OUT = path.join(__dirname, '..', 'questions-dental-tech.json')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const APPLY = process.argv.includes('--apply')

// 只收 4 卷筆試（牙體技術學一~四）；s5/s6 為實作科目（雕刻/排列）不收
const PAPERS = [
  ['牙體技術學(一)', 'dt_basic'], ['牙體技術學(二)', 'dt_fixed'],
  ['牙體技術學(三)', 'dt_removable'], ['牙體技術學(四)', 'dt_ortho'],
]
// [code, c, s前2碼]
const SESSIONS = [
  ['107110', '111', '10'], ['108110', '111', '10'], ['109110', '111', '10'],
  ['110111', '111', '10'], ['111110', '109', '08'],
  ['112110', '107', '07'], ['113100', '107', '07'], ['114100', '107', '07'],
]
const sessionName = () => '第二次'

async function getPdf(kind, code, c, s) {
  const fn = path.join(CACHE, `dentaltech_${kind}_${code}_c${c}_s${s}.pdf`)
  try { const b = fs.readFileSync(fn); if (b.length > 1000) return b } catch {}
  const buf = await fetchPdf(buildMoexUrl(kind, code, c, s), { userAgent: UA, referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' })
  fs.writeFileSync(fn, buf)
  return buf
}

async function main() {
  let all = []
  try { all = JSON.parse(fs.readFileSync(OUT, 'utf8')).questions || [] } catch {}
  const existing = new Set(all.map(q => q.id))
  let added = 0
  for (const [code, c, sb] of SESSIONS) {
    const year = code.slice(0, 3)
    for (let pi = 0; pi < PAPERS.length; pi++) {
      const s = sb + '0' + (pi + 1)
      const [subject, tag] = PAPERS[pi]
      let qbuf, abuf
      try {
        qbuf = await getPdf('Q', code, c, s)
        abuf = await getPdf('S', code, c, s)
      } catch (e) { console.log(`  ✗ ${code} ${subject}: ${e.message}`); continue }
      const head = (await pdfParse(qbuf)).text.slice(0, 600).normalize('NFKC')
      if (!head.includes('牙體技術師')) { console.log(`  ⚠ ${code} s${s} 類科不符`); continue }
      let parsed
      try { parsed = await parseColumnAware(qbuf) } catch (e) { console.log(`  ✗ parse ${code} s${s}`); continue }
      // 答案：連續字串優先，網格式 fallback
      let answers = {}
      const atext = (await pdfParse(abuf)).text.normalize('NFKC')
      let astr = ''
      for (const am of atext.matchAll(/答\s*案\s*([ABCD]+)/g)) astr += am[1]
      if (astr.length >= 20) astr.split('').forEach((ch, i) => { answers[i + 1] = ch })
      else { try { answers = await parseAnswersColumnAware(abuf) } catch {} }
      let n = 0
      for (const [num, q] of Object.entries(parsed)) {
        const qn = parseInt(num)
        if (qn < 1 || qn > 50) continue
        const ans = answers[qn]
        if (!ans || !/^[ABCD]$/.test(ans)) continue
        if (!q.question || !q.options || ['A', 'B', 'C', 'D'].some(x => !q.options[x])) continue
        const id = `${code}_${pi + 1}_${qn}`
        if (existing.has(id)) continue
        all.push({
          id, roc_year: year, session: sessionName(), exam_code: code,
          subject, subject_tag: tag, subject_name: subject,
          stage_id: 0, number: qn, question: q.question, options: q.options,
          answer: ans, explanation: '',
        })
        existing.add(id); n++; added++
      }
      console.log(`  ${code} ${subject}: ${n} 題`)
      await sleep(120)
    }
  }
  console.log(`\n新增 ${added}，總計 ${all.length}`)
  if (APPLY) fs.writeFileSync(OUT, JSON.stringify({ questions: all, total: all.length }, null, 2) + '\n')
  else console.log('(dry-run)')
}
main().catch(e => { console.error(e); process.exit(1) })
