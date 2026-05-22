#!/usr/bin/env node
// 補爬護理師 113 年第二次（code 113100, c102）— 題庫原本完全缺這一場次。
// 5 卷各 50 題（新制）。subject 設為卷別名，子科目交給 tag-subsubject-nursing.js。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')
const { fetchPdf, buildMoexUrl } = require('./lib/pdf-fetcher')
const { parseColumnAware, parseAnswersColumnAware } = require('./lib/moex-column-parser')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
const CACHE = path.join(__dirname, '..', '_tmp', 'pdf-cache')
const QFILE = path.join(__dirname, '..', 'questions-nursing.json')
const APPLY = process.argv.includes('--apply')
const CODE = '113100', C = '102'

// [卷別名, id slug, s-code]
const PAPERS = [
  ['基礎醫學',               'basic_medicine',  '0201'],
  ['基本護理學與護理行政',   'basic_nursing',   '0202'],
  ['內外科護理學',           'med_surg',        '0203'],
  ['產兒科護理學',           'obs_ped',         '0204'],
  ['精神科與社區衛生護理學', 'psych_community', '0205'],
]

async function getPdf(kind, s) {
  const fn = path.join(CACHE, `nursing_${kind}_${CODE}_c${C}_s${s}.pdf`)
  try { const b = fs.readFileSync(fn); if (b.length > 1000) return b } catch {}
  const buf = await fetchPdf(buildMoexUrl(kind, CODE, C, s), {
    userAgent: UA, referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx',
  })
  fs.writeFileSync(fn, buf)
  return buf
}

async function main() {
  const all = JSON.parse(fs.readFileSync(QFILE, 'utf8'))
  const existing = new Set(all.map(q => q.id))
  if (all.some(q => String(q.exam_code) === CODE)) {
    console.log('⚠ 題庫已有 113100 資料，請先確認是否重複');
  }
  const fresh = []

  for (const [subject, slug, s] of PAPERS) {
    let qbuf, abuf
    try { qbuf = await getPdf('Q', s); abuf = await getPdf('S', s) }
    catch (e) { console.log(`✗ ${subject}: 下載失敗 ${e.message}`); continue }

    // 驗證考試名稱
    const head = (await pdfParse(qbuf)).text.slice(0, 400).normalize('NFKC')
    if (!head.includes('護理師') || !head.includes('第二次')) {
      console.log(`✗ ${subject}: PDF 標頭非「113第二次護理師」，跳過`); continue
    }

    let parsed
    try { parsed = await parseColumnAware(qbuf) } catch (e) { console.log(`✗ parse ${subject}`); continue }
    let answers = {}
    try { answers = await parseAnswersColumnAware(abuf) } catch {}
    if (Object.keys(answers).length < 25) {
      const atext = (await pdfParse(abuf)).text.normalize('NFKC')
      let astr = ''
      for (const m of atext.matchAll(/答\s*案\s*([ABCD]+)/g)) astr += m[1]
      if (astr.length >= 25) { answers = {}; astr.split('').forEach((ch, i) => { answers[i + 1] = ch }) }
    }

    let n = 0
    for (const [num, q] of Object.entries(parsed)) {
      const qn = parseInt(num)
      if (qn < 1 || qn > 60) continue
      const ans = answers[qn]
      if (!ans || !/^[ABCD]$/.test(ans)) continue
      if (!q.question || !q.options || ['A', 'B', 'C', 'D'].some(x => !q.options[x])) continue
      const id = `${CODE}_${slug}_${qn}`
      if (existing.has(id)) continue
      fresh.push({
        id, roc_year: '113', session: '第二次', exam_code: CODE,
        subject, subject_tag: '', subject_name: subject, stage_id: 0,
        number: qn, question: q.question, options: q.options, answer: ans, explanation: '',
      })
      existing.add(id); n++
    }
    console.log(`  ${subject}: ${n} 題`)
  }

  console.log(`\n113第二次 共解析 ${fresh.length} 題`)
  if (!APPLY) { console.log('(dry-run，未寫檔)'); return }
  all.push(...fresh)
  fs.writeFileSync(QFILE, JSON.stringify(all, null, 2) + '\n')
  console.log(`✓ 已寫入 questions-nursing.json（總計 ${all.length} 題）`)
  console.log('→ 接著請執行 node scripts/tag-subsubject-nursing.js 補子科目標記')
}
main().catch(e => { console.error(e); process.exit(1) })
