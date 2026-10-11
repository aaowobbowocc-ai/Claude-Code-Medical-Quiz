#!/usr/bin/env node
/**
 * 修「同場次代碼 + 同題號」的跨考試覆蓋：某個題號被另一個考試的題佔走。
 *
 * 怎麼發現的：dental2 104090 卷一 #50/#63/#78 的題幹在原卷整卷都找不到，
 * 而同樣的題幹出現在 doctor2 104090 醫學(五) 的**同題號、同答案**。
 * 104090 是醫師與牙醫共用的場次代碼，爬蟲拿「場次代碼 + 題號」當寫入位置，
 * 於是跨考試互相覆蓋。
 *
 * ⚠️ 命中率體檢抓不到這種：這卷 80 題有 77 題題號完全相符（96%），
 * 遠在「<50% 才告警」的門檻之上。要抓只能逐題問「這題在自己的卷上嗎」。
 *
 * 兩道閘，兩個都過才覆寫：
 *   1. 我們現存的題幹，在自己那張原卷上**整卷找不到**（確認是外來的）
 *   2. 同樣的題幹在 donor 考試的同場次同題號找得到（確認覆蓋來源）
 * 原卷解析不出乾淨的四個選項就不動。id 一律保留。
 *
 *   node scripts/repair-cross-exam-overwrite.js            # dry-run
 *   node scripts/repair-cross-exam-overwrite.js --apply
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve')
const { pdfStems } = require('./lib/moex-pdf-parse')
const { skeleton } = require('./lib/moex-normalize')
const { paperQuestions } = require('./fill-civil-gaps')
const { sheetMap } = require('./lib/moex-answer-geo')
const { atomicWriteJson } = require('./lib/atomic-write')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const L = ['A', 'B', 'C', 'D']
const FILE = e => e === 'doctor1' ? 'questions.json' : `questions-${e}.json`

// 受害卷 → 懷疑的 donor 考試。目前只有這一組，發現新的就加進來。
const TARGETS = [
  { exam: 'dental2', code: '104090', subject: '卷一', donors: ['doctor2'] },
]

const near = (a, b) => {
  const x = skeleton(String(a)), y = skeleton(String(b))
  if (!x || !y) return false
  return x.includes(y.slice(0, 20)) || y.includes(x.slice(0, 20))
}

;(async () => {
  const cache = {}
  const load = e => cache[FILE(e)] || (cache[FILE(e)] = JSON.parse(fs.readFileSync(path.join(BK, FILE(e)), 'utf8')))
  let fixed = 0, skipped = 0

  for (const t of TARGETS) {
    const arr = (j => j.questions || j)(load(t.exam))
    const items = arr.filter(q => String(q.exam_code) === String(t.code) && q.subject === t.subject)
    const p = await resolvePaper({ exam: t.exam, code: t.code, subject: t.subject, year: String(items[0]?.roc_year), items })
    if (!p) { console.log(`✗ ${t.exam} ${t.code} ${t.subject}：對不到原卷`); continue }
    console.log(`\n${t.exam} ${t.code} ${t.subject} → 原卷「${p.subject}」(c=${p.c} s=${p.s})`)
    const stems = await pdfStems(await fetchSheet('Q', t.code, p.c, p.s))
    const parsed = await paperQuestions(t.code, p.c, p.s)
    const ans = (await sheetMap(t.code, p.c, p.s, Math.max(80, items.length))).map

    // 閘 1：題幹在整卷找不到的，就是外來的
    const foreign = items.filter(q => ![...stems.values()].some(s => near(q.question, s)))
    console.log(`  整卷 ${items.length} 題，題幹在原卷找不到的 ${foreign.length} 題`)

    for (const q of foreign) {
      // 閘 2：donor 的同場次同題號是不是同一題
      let from = null
      for (const d of t.donors) {
        const dArr = (j => j.questions || j)(load(d))
        const hit = dArr.find(x => String(x.exam_code) === String(t.code) && +x.number === +q.number && near(x.question, q.question))
        if (hit) { from = `${d} ${hit.subject} #${hit.number}` ; break }
      }
      if (!from) { console.log(`  ⊘ #${q.number}：找不到覆蓋來源，不動（可能是別的成因）`); skipped++; continue }

      const o = parsed.get(+q.number)
      const off = ans.get(+q.number)
      if (!o || !off || !/^[ABCD]$/.test(String(off))) { console.log(`  ⊘ #${q.number}：原卷解析不到或答案不明`); skipped++; continue }
      const opts = L.map(x => String(o.options[x] || ''))
      if (opts.some(x => !x.trim()) || new Set(opts).size !== 4) { console.log(`  ⊘ #${q.number}：原卷選項不乾淨`); skipped++; continue }

      console.log(`\n  #${q.number}  覆蓋來源：${from}`)
      console.log(`    移除: ${String(q.question).replace(/\s+/g, ' ').slice(0, 58)}  (答${q.answer})`)
      console.log(`    還原: ${String(o.stem).replace(/\s+/g, ' ').slice(0, 58)}  (答${off})`)
      console.log(`    選項: ${opts.join(' | ').slice(0, 96)}`)
      if (APPLY) {
        q.question = String(o.stem)
        q.options = { A: opts[0], B: opts[1], C: opts[2], D: opts[3] }
        q.answer = String(off)
        q.explanation = ''
        delete q.disputed
        delete q.images
      }
      fixed++
    }
  }

  console.log(`\n還原 ${fixed} 題｜跳過 ${skipped}${APPLY ? '' : '（dry-run）'}`)
  if (APPLY && fixed) {
    for (const [f, j] of Object.entries(cache)) {
      const arr = j.questions || j
      if (j.total !== undefined) j.total = arr.length
      atomicWriteJson(path.join(BK, f), j)
    }
    console.log('✅ 已寫回')
    console.log('⚠️ 還原的含圖題還沒有圖，接著跑：node scripts/extract-missing-figures.js --exam=dental2 --apply')
  }
})().catch(e => { console.error(e.stack); process.exit(1) })
