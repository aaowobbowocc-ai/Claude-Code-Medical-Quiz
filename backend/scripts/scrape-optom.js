#!/usr/bin/env node
// 爬驗光師（高考，5 卷）+ 驗光生（普考，3 卷）。純測驗題、無 ABCD 標記雙欄格式。
// 讀 _tmp/_probe-optom.json，每場次按 s 排序對應卷別，用 column parser 解析。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')
const { fetchPdf, buildMoexUrl } = require('./lib/pdf-fetcher')
const { parseColumnAware, parseAnswersColumnAware } = require('./lib/moex-column-parser')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const APPLY = process.argv.includes('--apply')

const EXAMS = {
  驗光師: {
    exam: 'optom', out: 'questions-optometrist.json',
    list: [
      ['眼球解剖生理學與倫理法規', 'opt_anatomy'], ['視覺光學', 'opt_visual_optics'],
      ['視光學', 'opt_optometry'], ['隱形眼鏡學與配鏡學', 'opt_contact_lens'],
      ['低視力學', 'opt_low_vision'],
    ],
  },
  驗光生: {
    exam: 'optomj', out: 'questions-optometrist-junior.json',
    list: [
      ['眼球構造與倫理法規概要', 'optj_anatomy'], ['驗光學概要', 'optj_optometry'],
      ['隱形眼鏡學概要', 'optj_contact_lens'],
    ],
  },
}
const sessionName = code => /0(2|3)0$/.test(code) ? '第一次' : '第二次'

async function getPdf(kind, exam, code, c, s) {
  const fn = path.join(CACHE, `${exam}_${kind}_${code}_c${c}_s${s}.pdf`)
  try { const b = fs.readFileSync(fn); if (b.length > 1000) return b } catch {}
  const buf = await fetchPdf(buildMoexUrl(kind, code, c, s), { userAgent: UA, referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' })
  fs.writeFileSync(fn, buf)
  return buf
}

async function main() {
  const probe = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '_tmp', '_probe-optom.json'), 'utf8'))
  const groups = {}
  for (const r of probe) (groups[`${r.klass}|${r.code}`] = groups[`${r.klass}|${r.code}`] || []).push(r)
  const files = {}
  for (const [k, rows] of Object.entries(groups)) {
    const [klass, code] = k.split('|')
    const cfg = EXAMS[klass]
    if (!cfg) continue
    if (!files[cfg.out]) {
      try { files[cfg.out] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', cfg.out), 'utf8')) }
      catch { files[cfg.out] = { questions: [], total: 0 } }
    }
    const data = files[cfg.out]
    const existing = new Set(data.questions.map(q => q.id))
    rows.sort((a, b) => a.s.localeCompare(b.s))
    let added = 0
    for (let pi = 0; pi < rows.length && pi < cfg.list.length; pi++) {
      const r = rows[pi]
      const [subject, tag] = cfg.list[pi]
      let qbuf, abuf
      try {
        qbuf = await getPdf('Q', cfg.exam, code, r.c, r.s)
        abuf = await getPdf('S', cfg.exam, code, r.c, r.s)
      } catch (e) { console.log(`  ✗ ${code} ${subject}: ${e.message}`); continue }
      const head = (await pdfParse(qbuf)).text.slice(0, 600).normalize('NFKC')
      if (!head.includes(klass)) { console.log(`  ⚠ ${code} s${r.s} 類科不符`); continue }
      let parsed
      try { parsed = await parseColumnAware(qbuf) } catch (e) { console.log(`  ✗ parse ${code} s${r.s}`); continue }
      // 答案 PDF 為網格式座標排版，用 column-aware 解析；退而求其次用連續字串
      let answers = {}
      try { answers = await parseAnswersColumnAware(abuf) } catch {}
      if (Object.keys(answers).length < 25) {
        const atext = (await pdfParse(abuf)).text.normalize('NFKC')
        let astr = ''
        for (const am of atext.matchAll(/答\s*案\s*([ABCD]+)/g)) astr += am[1]
        if (astr.length >= 25) { answers = {}; astr.split('').forEach((ch, i) => { answers[i + 1] = ch }) }
      }
      let n = 0
      for (const [num, q] of Object.entries(parsed)) {
        const qn = parseInt(num)
        if (qn < 1 || qn > 50) continue
        const ans = answers[qn]
        if (!ans || !/^[ABCD]$/.test(ans)) continue
        if (!q.question || !q.options || ['A', 'B', 'C', 'D'].some(x => !q.options[x])) continue
        const id = `${code}_${pi + 1}_${qn}`
        if (existing.has(id)) continue
        data.questions.push({
          id, roc_year: code.slice(0, 3), session: sessionName(code), exam_code: code,
          subject, subject_tag: tag, subject_name: subject,
          stage_id: 0, number: qn, question: q.question, options: q.options,
          answer: ans, explanation: '',
        })
        existing.add(id); n++; added++
      }
      console.log(`  ${klass} ${code} ${subject}: ${n} 題`)
      await sleep(110)
    }
    console.log(`${k}: +${added}`)
  }
  for (const [out, data] of Object.entries(files)) {
    data.total = data.questions.length
    console.log(`${out}: 總計 ${data.total}`)
    if (APPLY) fs.writeFileSync(path.join(__dirname, '..', out), JSON.stringify(data, null, 2) + '\n')
  }
  console.log(APPLY ? '(已套用)' : '(dry-run)')
}
main().catch(e => { console.error(e); process.exit(1) })
