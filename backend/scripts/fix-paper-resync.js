#!/usr/bin/env node
// 整卷重抽校正：把某卷所有題的選項+答案對齊官方（column-parser + 官方答案卷）。
// 用於「整卷系統性選項位移/答案錯位」的卷。stem 前綴驗證確保對到同題；
// 只在重抽出 4 個乾淨相異選項時動作。預設 dry，--apply 寫入。
// 用法：node scripts/fix-paper-resync.js <file> <code> <c> <s> <subject_tag> [--apply]
const fs = require('fs')
const { fetchPdf, buildMoexUrl } = require('./lib/pdf-fetcher')
const { parseColumnAware, parseAnswersColumnAware } = require('./lib/moex-column-parser')
const [file, code, c, s, tag] = process.argv.slice(2)
const APPLY = process.argv.includes('--apply')
// --no-answer：只修選項、不動答案（用於答案卷 parser 對該卷欄位錯位、原答案可信時）
const NO_ANSWER = process.argv.includes('--no-answer')
const UA = 'Mozilla/5.0', REF = 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx'
const norm = x => (x || '').replace(/[-]/g, '').replace(/\s/g, '')

async function getPdf(t) {
  const cached = `_tmp/bullet-cloze/${t}_${code}_${c}_${s}.pdf`
  if (fs.existsSync(cached) && fs.statSync(cached).size > 1000) return fs.readFileSync(cached)
  for (let i = 0; i < 4; i++) {
    try { return await fetchPdf(buildMoexUrl(t, code, c, s), { userAgent: UA, referer: REF }) }
    catch (e) { if (i === 3) throw e; await new Promise(r => setTimeout(r, 1500)) }
  }
}
async function main() {
  const qbuf = await getPdf('Q')
  const abuf = await getPdf('S')
  const P = await parseColumnAware(qbuf)
  let A = {}; try { A = await parseAnswersColumnAware(abuf) } catch (e) { console.log('ansErr', e.message) }
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
  const arr = Array.isArray(data) ? data : data.questions
  let optFix = 0, ansFix = 0, skip = 0, ok = 0
  const samples = []
  const tags = tag.split(',')
  for (const o of arr) {
    if (String(o.exam_code) !== code || !tags.includes(o.subject_tag)) continue
    const p = P[o.number]
    if (!p || !p.options || ['A','B','C','D'].some(k => !p.options[k]) || new Set(['A','B','C','D'].map(k=>p.options[k])).size !== 4) { skip++; continue }
    // 驗證對到同題：重抽題幹前綴與原題幹相符（任一方為另一方前綴）
    const op = norm(o.question), pp = norm(p.question)
    if (!pp || !(op.startsWith(pp.slice(0,18)) || pp.startsWith(op.slice(0,18)))) { skip++; continue }
    const off = A[o.number]
    const curCat = norm(['A','B','C','D'].map(k => (o.options||{})[k]).join('|'))
    const newCat = norm(['A','B','C','D'].map(k => p.options[k]).join('|'))
    const optDiff = curCat !== newCat
    // 現答案含逗號＝送分/雙答（如「A,D」），保留不覆蓋
    const ansDiff = !NO_ANSWER && off && /^[ABCD]$/.test(off) && off !== o.answer && !/[,，]/.test(o.answer || '')
    if (!optDiff && !ansDiff) { ok++; continue }
    if (optDiff) optFix++
    if (ansDiff) ansFix++
    if (samples.length < 12) samples.push(`#${o.number} ${optDiff?'選項':''}${ansDiff?`答案${o.answer}->${off}`:''}`)
    if (APPLY) {
      if (optDiff) o.options = { A: p.options.A, B: p.options.B, C: p.options.C, D: p.options.D }
      if (p.question && pp.length > op.length) o.question = p.question  // 補較完整題幹
      if (ansDiff) o.answer = off
    }
  }
  console.log(`${code}/${tag}: 改選項 ${optFix} 改答案 ${ansFix} 已正確 ${ok} 跳過 ${skip}`)
  console.log(samples.join('  '))
  if (APPLY) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); console.log('✅ 已寫入') }
}
main().catch(e => { console.error(e); process.exit(1) })
