#!/usr/bin/env node
// 補爬護理師「第三次」國考 112/113/114 三場（題庫原本完全缺）。
// 112-3=112180, 113-3=113180, 114-3=114170；皆 c=101，5 卷 s=0101/0102/0103/0201/0202。
// 新制每卷 50 題。subject 設卷別名、subject_tag 留空交給 tag-subsubject-nursing.js。
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

// [民國年, code]
const SESSIONS = [['112', '112180'], ['113', '113180'], ['114', '114170']]
const C = '101'
// [卷別名, id slug, s-code]
const PAPERS = [
  ['基礎醫學',               'basic_medicine',  '0101'],
  ['基本護理學與護理行政',   'basic_nursing',   '0102'],
  ['內外科護理學',           'med_surg',        '0103'],
  ['產兒科護理學',           'obs_ped',         '0201'],
  ['精神科與社區衛生護理學', 'psych_community', '0202'],
]

async function getPdf(kind, code, s) {
  const fn = path.join(CACHE, `nursing_${kind}_${code}_c${C}_s${s}.pdf`)
  try { const b = fs.readFileSync(fn); if (b.length > 1000) return b } catch {}
  const buf = await fetchPdf(buildMoexUrl(kind, code, C, s), {
    userAgent: UA, referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx',
  })
  if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true })
  fs.writeFileSync(fn, buf)
  return buf
}

async function main() {
  const all = JSON.parse(fs.readFileSync(QFILE, 'utf8'))
  const existing = new Set(all.map(q => q.id))
  const fresh = []

  for (const [year, code] of SESSIONS) {
    if (all.some(q => String(q.exam_code) === code)) {
      console.log(`⚠ 題庫已有 ${code}，跳過該場`); continue
    }
    console.log(`\n=== ${year} 第三次 (code ${code}) ===`)
    for (const [subject, slug, s] of PAPERS) {
      let qbuf, abuf
      try { qbuf = await getPdf('Q', code, s); abuf = await getPdf('S', code, s) }
      catch (e) { console.log(`✗ ${subject}: 下載失敗 ${e.message}`); continue }

      const head = (await pdfParse(qbuf)).text.slice(0, 500).normalize('NFKC')
      if (!head.includes('護理師') || !head.includes('第三次')) {
        console.log(`✗ ${subject}: PDF 標頭非「${year}第三次護理師」，跳過`); continue
      }

      let parsed
      try { parsed = await parseColumnAware(qbuf) } catch { console.log(`✗ parse ${subject}`); continue }
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
        if (qn < 1 || qn > 100) continue
        const ans = answers[qn]
        if (!ans || !/^[ABCD]$/.test(ans)) continue
        if (!q.question || !q.options || ['A', 'B', 'C', 'D'].some(x => !q.options[x])) continue
        const id = `${code}_${slug}_${qn}`
        if (existing.has(id)) continue
        fresh.push({
          id, roc_year: year, session: '第三次', exam_code: code,
          subject, subject_tag: '', subject_name: subject, stage_id: 0,
          number: qn, question: q.question, options: q.options, answer: ans, explanation: '',
        })
        existing.add(id); n++
      }
      console.log(`  ${subject}(s=${s}): ${n} 題`)
    }
  }

  console.log(`\n三場第三次 共解析 ${fresh.length} 題`)
  if (!APPLY) { console.log('(dry-run，未寫檔；加 --apply 寫入)'); return }
  all.push(...fresh)
  fs.writeFileSync(QFILE, JSON.stringify(all, null, 2) + '\n')
  console.log(`✓ 已寫入 questions-nursing.json（總計 ${all.length} 題）`)
  console.log('→ 接著執行 node scripts/tag-subsubject-nursing.js 補子科目標記')
}
main().catch(e => { console.error(e); process.exit(1) })
