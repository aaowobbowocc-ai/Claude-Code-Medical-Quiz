#!/usr/bin/env node
// 免費修復醫學類「選項 bullet 洩漏」壞題（護理/營養/中醫/社工/醫師二階）。
// 用現成 parseColumnAware（mupdf 欄位感知）重抽 + parseAnswersColumnAware 官方答案。
// 防呆：重抽 4 選項串接(正規化) 必須等於原 4 選項串接 → 同內容只是重切才套用，
//       切錯/掉字者自動跳過（避免 #49 「G蛋白」被切斷那種誤修）。
// 用法：node scripts/fix-medical-bullet.js [--apply] [--only <code>]
const fs = require('path') && require('fs')
const { fetchPdf, buildMoexUrl } = require('./lib/pdf-fetcher')
const { parseColumnAware, parseAnswersColumnAware } = require('./lib/moex-column-parser')

// {file, code, c, s, tags:[subject_tag...]}  — s 對應的實體卷，tags 為該卷涵蓋的細分類
const JOBS = [
  { file: 'questions-nursing.json', code: '104030', c: '109', s: '0107', tags: ['microimmun', 'pharmacology', 'physiology'] },
]

const UA = 'Mozilla/5.0'
const norm = s => (s || '').replace(/[-]/g, '').replace(/[^a-z0-9一-鿿]/gi, '').toLowerCase()
const isBulLead = v => typeof v === 'string' && v && v.charCodeAt(0) >= 0xE18C && v.charCodeAt(0) <= 0xE18F
  && !v.replace(/[-\s　]/g, '').trim()

async function getPdf(t, code, c, s) {
  const fn = `_tmp/medbul_${t}_${code}_${c}_${s}.pdf`
  if (fs.existsSync(fn) && fs.statSync(fn).size > 1000) return fs.readFileSync(fn)
  const buf = await fetchPdf(buildMoexUrl(t, code, c, s), { userAgent: UA, referer: 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx' })
  fs.writeFileSync(fn, buf); return buf
}

async function main() {
  const APPLY = process.argv.includes('--apply')
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null
  const cache = {}
  let grandFix = 0, grandChange = 0, grandSkip = 0
  for (const job of JOBS) {
    if (only && job.code !== only) continue
    let qbuf, abuf
    try { qbuf = await getPdf('Q', job.code, job.c, job.s); abuf = await getPdf('S', job.code, job.c, job.s) }
    catch (e) { console.log(`⚠ ${job.code} s=${job.s}: PDF ${e.message}`); continue }
    let parsed, answers = {}
    try { parsed = await parseColumnAware(qbuf) } catch (e) { console.log(`⚠ parse ${job.code}: ${e.message}`); continue }
    try { answers = await parseAnswersColumnAware(abuf) } catch { }
    if (!cache[job.file]) cache[job.file] = JSON.parse(fs.readFileSync(job.file, 'utf-8'))
    const data = cache[job.file]
    const arr = Array.isArray(data) ? data : data.questions
    let fix = 0, change = 0, skip = 0
    for (const o of arr) {
      if (String(o.exam_code) !== job.code || !job.tags.includes(o.subject_tag)) continue
      if (!o.options || typeof o.options !== 'object') continue
      const vals = ['A', 'B', 'C', 'D'].map(k => o.options[k])
      if (!vals.some(isBulLead)) continue                       // 非壞題
      const p = parsed[o.number]
      if (!p || !p.options || ['A', 'B', 'C', 'D'].some(k => !p.options[k])) { skip++; continue }
      // 防呆：重抽 4 選項串接 == 原 4 選項串接（同內容重切）
      const origCat = norm(vals.join(''))
      const newCat = norm(['A', 'B', 'C', 'D'].map(k => p.options[k]).join(''))
      if (origCat !== newCat) { skip++; continue }
      const off = answers[o.number]
      if (APPLY) {
        o.options = { A: p.options.A, B: p.options.B, C: p.options.C, D: p.options.D }
        if (off && /^[ABCD]$/.test(off)) { if (off !== o.answer) change++; o.answer = off }
      } else if (off && off !== o.answer) change++
      fix++
    }
    console.log(`${job.code} s=${job.s} ${job.tags.join('/')}: 修 ${fix} (答案變 ${change}) 跳過 ${skip}`)
    grandFix += fix; grandChange += change; grandSkip += skip
  }
  if (APPLY) {
    for (const [f, d] of Object.entries(cache)) fs.writeFileSync(f, JSON.stringify(d, null, 2))
    console.log(`\n✅ 已套用，共修 ${grandFix}（答案修正 ${grandChange}）跳過 ${grandSkip}`)
  } else console.log(`\n(dry) 修 ${grandFix}（答案變 ${grandChange}）跳過 ${grandSkip}`)
}
main().catch(e => { console.error(e); process.exit(1) })
