#!/usr/bin/env node
// 爬臨床/諮商心理師 100-105 舊年份。讀 _tmp/_probe-psych-100.json，
// 每場次按 s 排序對應卷別 index，用 column parser 解析。append 到 questions JSON。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')
const { fetchPdf, buildMoexUrl } = require('./lib/pdf-fetcher')
const { parseColumnAware, parseAnswersColumnAware, parseAnswersText } = require('./lib/moex-column-parser')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const APPLY = process.argv.includes('--apply')

const PAPERS = {
  臨床心理師: {
    exam: 'clinpsy', out: 'questions-clinical-psychology.json',
    list: [
      ['臨床心理學基礎', 'cp_basic'], ['臨床心理學總論(一)', 'cp_general_1'],
      ['臨床心理學總論(二)', 'cp_general_2'], ['臨床心理學特論(一)', 'cp_special_1'],
      ['臨床心理學特論(二)', 'cp_special_2'], ['臨床心理學特論(三)', 'cp_special_3'],
    ],
  },
  諮商心理師: {
    exam: 'counpsy', out: 'questions-counseling-psychology.json',
    list: [
      ['諮商的心理學基礎', 'cou_basic'], ['諮商與心理治療理論', 'cou_theory'],
      ['諮商與心理治療實務與專業倫理', 'cou_practice'], ['心理健康與變態心理學', 'cou_mental_health'],
      ['個案評估與心理衡鑑', 'cou_assessment'], ['團體諮商與心理治療', 'cou_group'],
    ],
  },
}
const sessionName = code => /(030|0140)$/.test(code) || /140$/.test(code) ? '第二次' : (/0(2|3)0$/.test(code) ? '第一次' : '第二次')

async function getPdf(kind, exam, code, c, s) {
  const fn = path.join(CACHE, `${exam}_${kind}_${code}_c${c}_s${s}.pdf`)
  try { const b = fs.readFileSync(fn); if (b.length > 1000) return b } catch {}
  const buf = await fetchPdf(buildMoexUrl(kind, code, c, s), { userAgent: UA, referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' })
  fs.writeFileSync(fn, buf)
  return buf
}

async function main() {
  const probe = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '_tmp', '_probe-psych-100.json'), 'utf8'))
  // group by (klass, code) → sorted-by-s list
  const groups = {}
  for (const r of probe) {
    const k = `${r.klass}|${r.code}`
    ;(groups[k] = groups[k] || []).push(r)
  }
  const files = {}
  for (const [k, rows] of Object.entries(groups)) {
    const [klass, code] = k.split('|')
    const cfg = PAPERS[klass]
    if (!cfg) continue
    if (!files[cfg.out]) {
      files[cfg.out] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', cfg.out), 'utf8'))
    }
    const data = files[cfg.out]
    const existing = new Set(data.questions.map(q => q.id))
    rows.sort((a, b) => a.s.localeCompare(b.s))
    let added = 0
    for (let pi = 0; pi < rows.length && pi < 6; pi++) {
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
      // 答案 PDF 格式：「答案CCACC…」連續 ABCD 字串
      let answers = {}
      const atext = (await pdfParse(abuf)).text.normalize('NFKC')
      let astr = ''
      for (const am of atext.matchAll(/答\s*案\s*([ABCD]+)/g)) astr += am[1]
      astr.split('').forEach((ch, i) => { answers[i + 1] = ch })
      if (Object.keys(answers).length < 20) {
        try { const c = await parseAnswersColumnAware(abuf); if (Object.keys(c).length > Object.keys(answers).length) answers = c } catch {}
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
