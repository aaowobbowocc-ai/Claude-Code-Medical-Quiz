#!/usr/bin/env node
/**
 * 用「選項文字」比對來更正答案——不是用字母，也不是用整卷對齊率。
 *
 * 為什麼要有這支：
 *  - 比**字母**會假警報：選項順序與原卷不同時，字母不同但答案其實是對的。
 *  - 用**整卷對齊率**會漏：audiologist 103100 行為聽力學對齊率 82.5%，
 *    落在「正常」區間所以 2026-09-19 的全站稽核沒動它，但裡面有 14 題答案是錯的
 *    （實測 #36 ASHA 學齡前聽篩是 20 dB HL 不是 15，官方答 B，我們存 D）。
 *
 * 判準（三個條件同時成立才改）：
 *  1. 我們的四個選項與原卷**逐位相同**（正規化掉全半形、括號、空白、標點）
 *  2. 四個選項都不是空的
 *  3. 我們的答案與標準答案卷不同
 * 逐位相同代表「字母指的是同一個選項」，這時標準答案卷的字母就能直接採用。
 * 選項對不起來的一律不動——那種要先把選項修對，不是改答案。
 *
 *   node scripts/fix-answers-by-option-text.js --exam=audiologist      # dry-run
 *   node scripts/fix-answers-by-option-text.js --exam=audiologist --apply
 *   node scripts/fix-answers-by-option-text.js --apply                 # 全站
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { resolvePaper } = require('./lib/moex-paper-resolve')
const { paperQuestions } = require('./fill-civil-gaps')
const { sheetMap } = require('./lib/moex-answer-geo')
const { atomicWriteJson } = require('./lib/atomic-write')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1]

// 不是考選部來源，resolvePaper 對不到
const SKIP = new Set(['gsat', 'ast', 'driver-car', 'driver-moto', 'post-indoor', 'post-outdoor',
  'railway-admin', 'railway-transport', 'state-finance', 'state-hr', 'state-it', 'state-mgmt',
  'teacher-elementary', 'teacher-kindergarten', 'teacher-secondary', 'teacher-special', 'teacher-special-gifted'])

const EXAM = f => f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '')
/** 比選項文字用：全半形、括號、空白、標點都正規化掉。 */
const norm = t => String(t || '').normalize('NFKC').replace(/[\s　（）()，,、。．·－-]/g, '').toLowerCase()

;(async () => {
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f))
  const report = []
  const mismatched = []
  let fixed = 0, skipped = 0, papers = 0, failed = 0
  for (const f of files) {
    const exam = EXAM(f)
    if (SKIP.has(exam) || (only && exam !== only)) continue
    const data = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'))
    const arr = data.questions || data
    if (!Array.isArray(arr)) continue

    // 依「場次＋科目」分卷
    const groups = new Map()
    for (const q of arr) {
      if (!q.exam_code || !q.subject) continue
      const k = q.exam_code + '\u0000' + q.subject
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(q)
    }
    let changedHere = 0
    for (const [k, items] of groups) {
      const [code, subject] = k.split('\u0000')
      let p = null
      try { p = await resolvePaper({ exam, code: String(code), subject, year: String(items[0].roc_year), items }) } catch {}
      if (!p) { failed++; continue }
      let parsed, ans
      try {
        parsed = await paperQuestions(String(code), p.c, p.s)
        ans = (await sheetMap(String(code), p.c, p.s, Math.max(80, items.length))).map
      } catch { failed++; continue }
      papers++
      for (const q of items) {
        const o = parsed.get(+q.number)
        const off = ans.get(+q.number)
        if (!o || !off || !/^[ABCD]$/.test(String(off))) continue
        if (String(q.answer) === String(off)) continue
        const ours = ['A', 'B', 'C', 'D'].map(x => norm(q.options[x]))
        const offs = ['A', 'B', 'C', 'D'].map(x => norm(o.options[x]))
        if (!ours.every(Boolean) || ours.join('|') !== offs.join('|')) {
          skipped++
          // 這些是「答案不同、而且選項也對不起來」的題——多半是選項本身壞了。
          // 記下來另案處理，不要在這裡改答案（改了只會蓋掉症狀）。
          mismatched.push({ exam, code, subject, n: q.number, ours: q.answer, off: String(off),
            ourOpts: ['A', 'B', 'C', 'D'].map(x => String(q.options[x] || '')),
            offOpts: ['A', 'B', 'C', 'D'].map(x => String(o.options[x] || '')),
            stem: String(q.question).replace(/\s+/g, ' ').slice(0, 60) })
          continue
        }
        report.push({ exam, code, subject, n: q.number, from: q.answer, to: String(off),
          stem: String(q.question).replace(/\s+/g, ' ').slice(0, 44) })
        if (APPLY) q.answer = String(off)
        fixed++; changedHere++
      }
    }
    if (changedHere) {
      console.log(`${exam}: 更正 ${changedHere} 題`)
      if (APPLY) atomicWriteJson(path.join(BK, f), data)
    }
  }

  console.log(`\n掃過 ${papers} 卷（${failed} 卷對不到或解析失敗）`)
  console.log(`可安全更正 ${fixed} 題；選項對不起來、不動 ${skipped} 題${APPLY ? '' : '（dry-run）'}`)
  const out = path.join(BK, '_tmp', 'answer-fix-by-option-text.json')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(report, null, 2))
  console.log(`📄 ${out}`)
  const out2 = path.join(BK, '_tmp', 'answer-diff-option-mismatch.json')
  fs.writeFileSync(out2, JSON.stringify(mismatched, null, 2))
  console.log(`📄 ${out2}（${mismatched.length} 題：答案不同且選項對不起來）`)
  for (const r of report.slice(0, 15)) {
    console.log(`  ${r.exam} ${r.code} ${r.subject.slice(0, 12)} #${r.n}  ${r.from}→${r.to}  ${r.stem}`)
  }
})().catch(e => { console.error(e.stack); process.exit(1) })
