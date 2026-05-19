#!/usr/bin/env node
// 爬臨床/諮商心理師 106-110 舊年份（無 ABCD 標記的雙欄格式，用 column parser）。
// 測驗題在「乙、測驗題部分」之後，題號 1-40。append 到既有 questions JSON。
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

const EXAMS = {
  clinpsy: {
    out: 'questions-clinical-psychology.json',
    papers: [
      ['臨床心理學基礎', 'cp_basic'], ['臨床心理學總論(一)', 'cp_general_1'],
      ['臨床心理學總論(二)', 'cp_general_2'], ['臨床心理學特論(一)', 'cp_special_1'],
      ['臨床心理學特論(二)', 'cp_special_2'], ['臨床心理學特論(三)', 'cp_special_3'],
    ],
    klass: '臨床心理師',
    sessions: [  // [code, c, s前2碼]
      ['106030','104','03'],['106110','104','03'],['107030','104','03'],['107110','104','03'],
      ['108020','104','03'],['108110','104','03'],['109030','104','03'],['109110','104','03'],
      ['110111','106','05'],
    ],
  },
  counpsy: {
    out: 'questions-counseling-psychology.json',
    papers: [
      ['諮商的心理學基礎', 'cou_basic'], ['諮商與心理治療理論', 'cou_theory'],
      ['諮商與心理治療實務與專業倫理', 'cou_practice'], ['心理健康與變態心理學', 'cou_mental_health'],
      ['個案評估與心理衡鑑', 'cou_assessment'], ['團體諮商與心理治療', 'cou_group'],
    ],
    klass: '諮商心理師',
    sessions: [
      ['106030','105','04'],['106110','105','04'],['107030','105','04'],['107110','105','04'],
      ['108020','105','04'],['108110','105','04'],['109030','105','04'],['109110','105','04'],
      ['110111','107','06'],
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
  for (const [exam, cfg] of Object.entries(EXAMS)) {
    const outPath = path.join(__dirname, '..', cfg.out)
    const data = JSON.parse(fs.readFileSync(outPath, 'utf8'))
    const all = data.questions
    const existing = new Set(all.map(q => q.id))
    let added = 0
    for (const [code, c, sb] of cfg.sessions) {
      const year = code.slice(0, 3)
      for (let pi = 0; pi < 6; pi++) {
        const s = sb + '0' + (pi + 1)
        const [subject, tag] = cfg.papers[pi]
        let qbuf, abuf
        try {
          qbuf = await getPdf('Q', exam, code, c, s)
          abuf = await getPdf('S', exam, code, c, s)
        } catch (e) { console.log(`  ✗ ${exam} ${code} ${subject}: ${e.message}`); continue }
        const head = (await pdfParse(qbuf)).text.slice(0, 600).normalize('NFKC')
        if (!head.includes(cfg.klass)) { console.log(`  ⚠ ${exam} ${code} s${s} 類科不符`); continue }
        let parsed
        try { parsed = await parseColumnAware(qbuf) } catch (e) { console.log(`  ✗ parse ${code} s${s}: ${e.message}`); continue }
        let answers = {}
        try { answers = await parseAnswersColumnAware(abuf) } catch {}
        if (Object.keys(answers).length < 20) {
          try { answers = parseAnswersText((await pdfParse(abuf)).text) } catch {}
        }
        let n = 0
        for (const [num, q] of Object.entries(parsed)) {
          const qn = parseInt(num)
          if (qn < 1 || qn > 40) continue
          const ans = answers[qn]
          if (!ans || !/^[ABCD]$/.test(ans)) continue
          if (!q.question || !q.options || ['A','B','C','D'].some(k => !q.options[k])) continue
          const id = `${code}_${pi + 1}_${qn}`
          if (existing.has(id)) continue
          all.push({
            id, roc_year: year, session: sessionName(code), exam_code: code,
            subject, subject_tag: tag, subject_name: subject,
            stage_id: 0, number: qn, question: q.question, options: q.options,
            answer: ans, explanation: '',
          })
          existing.add(id); n++; added++
        }
        console.log(`  ${exam} ${code} ${subject}: ${n} 題`)
        await sleep(120)
      }
    }
    console.log(`${exam}: +${added} 題，總計 ${all.length}`)
    if (APPLY) { data.total = all.length; fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n') }
  }
  console.log(APPLY ? '(已套用)' : '(dry-run)')
}
main().catch(e => { console.error(e); process.exit(1) })
