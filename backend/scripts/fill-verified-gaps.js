#!/usr/bin/env node
/**
 * 補 verify-coverage-gaps.js 查證過「官方真的有、我們真的沒有」的題。
 *
 * 前置：
 *   node scripts/coverage-report.js --json
 *   node scripts/verify-coverage-gaps.js
 * 然後：
 *   node scripts/fill-verified-gaps.js            # dry-run
 *   node scripts/fill-verified-gaps.js --apply
 *   node scripts/fill-verified-gaps.js --exam dental-tech --apply
 *
 * 只補「該卷該題號我們沒有」的題，既有的題一個都不動（避免蓋掉人工修過的內容）。
 * 選項不齊或答案卷取不到的就跳過——寧可少一題，也不要給沒有正解的題。
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { paperQuestions } = require('./fill-civil-gaps')
const { sheetMap } = require('./lib/moex-answer-geo')
const { atomicWriteJson } = require('./lib/atomic-write')

const ROOT = path.join(__dirname, '..')
const VERIFIED = path.join(ROOT, '_tmp', 'coverage-gaps-verified.json')
const APPLY = process.argv.includes('--apply')
const arg = k => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null }
const ONLY = arg('--exam')

const fileOf = e => e === 'doctor1' ? 'questions.json' : `questions-${e}.json`

const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve')
const { pdfText } = require('./lib/moex-pdf-parse')

/** 取試題 PDF 開頭的「考試別／等別」。取不到回 null。 */
async function identity(code, c, s) {
  try {
    const buf = await fetchSheet('Q', code, c, s)
    if (!buf) return null
    const t = (await pdfText(buf)).replace(/\s+/g, ' ').slice(0, 400).normalize('NFC')
    const e = /考試別\s*[：:]\s*([^\s]{2,40}?)(?=\s*等\s*別|\s*類\s*科|$)/.exec(t)
    const l = /等\s*別\s*[：:]\s*([^\s]{2,20}?)(?=\s*類\s*科|\s*科\s*目|$)/.exec(t)
    if (!e && !l) return null
    return { exam: e ? e[1] : '', level: l ? l[1] : '' }
  } catch { return null }
}

/**
 * 整卷都沒有時，resolvePaper 沒有題目可以比對內容，只能靠科目名挑——
 * 同一個場次代碼底下別的**等別**也有同名科目，挑錯就整卷灌進別人的題。
 * 實測：關務三等的「英文」抓到關務**五等**的卷（五等是 50 題純選擇，
 * 三等是申論＋25 選擇），45 題差點就進去了。
 * 拿同科目另一年我們已經有的卷當基準，比對「考試別／等別」。
 */
async function levelMatches(exam, arr, subject, target) {
  const others = arr.filter(q => q.subject === subject && String(q.exam_code) !== String(target.code))
  const codes = [...new Set(others.map(q => String(q.exam_code)))].sort().reverse().slice(0, 3)
  for (const code of codes) {
    const items = others.filter(q => String(q.exam_code) === code)
    let p = null
    try {
      p = await resolvePaper({ exam, code, subject, year: String(items[0].roc_year), items })
    } catch {}
    if (!p) continue
    const base = await identity(code, p.c, p.s)
    const cur = await identity(String(target.code), target.c, target.s)
    if (!base || !cur) continue
    return { ok: base.exam === cur.exam && base.level === cur.level, base, cur }
  }
  return { ok: true, base: null, cur: null }   // 無從判斷就放行
}

;(async () => {
  if (!fs.existsSync(VERIFIED)) {
    console.error('找不到 _tmp/coverage-gaps-verified.json，先跑 verify-coverage-gaps.js')
    process.exit(1)
  }
  const rows = JSON.parse(fs.readFileSync(VERIFIED, 'utf8')).real
    .filter(r => !ONLY || r.exam === ONLY)
  console.log(`要補 ${rows.length} 卷\n`)

  const cache = {}
  let added = 0, skipped = 0
  for (const r of rows) {
    const f = fileOf(r.exam)
    const data = cache[f] || (cache[f] = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')))
    const arr = data.questions || data
    const mine = arr.filter(q => String(q.exam_code) === String(r.code) && q.subject === r.paper)
    // ⚠️ 整卷都沒有時樣板會取到**別的年份**的列，若照抄它的 roc_year/exam_code，
    //    補進去的題就會掛在別的場次底下（關務 113 英文 45 題實測被標成 105 年，
    //    105 年的英文卷因此變成 70 題）。年份／場次一律用缺口列的值覆蓋。
    const proto = mine[0] || arr.find(q => q.subject === r.paper)
    if (!proto) { console.log(`  ✗ ${r.exam} ${r.year} ${r.paper}: 找不到樣板列`); continue }
    const sessionOf = arr.find(q => String(q.exam_code) === String(r.code))
    if (!mine.length) {
      const chk = await levelMatches(r.exam, arr, r.paper, r)
      if (!chk.ok) {
        console.log(`  ⛔ ${r.exam} ${r.year} ${r.paper}: 抓到的是「${chk.cur.exam}／${chk.cur.level}」，` +
          `本考試是「${chk.base.exam}／${chk.base.level}」，跳過`)
        continue
      }
    }
    const has = new Set(mine.map(q => +q.number))

    let parsed, ans
    try {
      parsed = await paperQuestions(String(r.code), r.c, r.s)
      ans = (await sheetMap(String(r.code), r.c, r.s, r.declared)).map
    } catch (e) { console.log(`  ✗ ${r.exam} ${r.year} ${r.paper}: ${e.message.slice(0, 50)}`); continue }

    // id 慣例跟著同卷既有的題走：純數字就接續編號，字串就照樣板改題號
    const nums = arr.map(q => Number(q.id)).filter(Number.isFinite)
    let nextId = (nums.length ? Math.max(...nums) : 0) + 1
    const idIsNumber = typeof proto.id === 'number'

    const rowsAdded = []
    for (let n = 1; n <= r.declared; n++) {
      if (has.has(n)) continue
      const o = parsed.get(n)
      const a = ans.get(n)
      if (!o || !a || !/^[A-E](,[A-E])*$/.test(String(a))) { skipped++; continue }
      const opts = {}
      for (const k of ['A', 'B', 'C', 'D']) opts[k] = String(o.options[k] || '').trim()
      if (Object.values(opts).some(t => !t)) { skipped++; continue }
      if (new Set(Object.values(opts)).size !== 4) { skipped++; continue }
      const stem = String(o.stem || '').replace(/^[\s.．、]+/, '')
      if (stem.length < 5) { skipped++; continue }
      const row = { ...proto }
      delete row.explanation
      Object.assign(row, {
        id: idIsNumber ? nextId++ : `${r.code}_gapfill_${r.paper}_${n}`,
        roc_year: String(r.year),
        session: (sessionOf && sessionOf.session) || r.session,
        exam_code: String(r.code),
        subject: r.paper,
        number: n, question: stem, options: opts, answer: String(a), explanation: '',
      })
      delete row.image; delete row.images; delete row.option_images
      delete row.disputed; delete row.incomplete; delete row.vision_uncertain
      rowsAdded.push(row)
    }
    if (rowsAdded.length) {
      if (APPLY) arr.push(...rowsAdded)
      added += rowsAdded.length
    }
    console.log(`  ${r.exam} ${r.year} ${r.session} ${r.paper}: 缺 ${r.short} → 補回 ${rowsAdded.length}`)
  }

  console.log(`\n共補 ${added} 題，跳過 ${skipped} 題（原卷解析不出來或沒有答案）${APPLY ? '' : '（dry-run）'}`)
  if (APPLY) {
    for (const [f, data] of Object.entries(cache)) {
      const arr = data.questions || data
      if (data.total !== undefined) data.total = arr.length
      if (data.metadata) data.metadata.last_updated = new Date().toISOString()
      atomicWriteJson(path.join(ROOT, f), data)
      console.log(`✅ ${f}（${arr.length} 題）`)
    }
  }
})().catch(e => { console.error(e.stack); process.exit(1) })
