#!/usr/bin/env node
/**
 * 卷別/題號對齊體檢：我們存的題目，有多少真的印在考選部那張卷上？
 *
 * 為什麼需要：這個專案出過三種「題數是滿的、內容卻錯」的事故——
 *   複製卷（藥師一階卷一＝卷三）、錯切（牙醫二階卷別混在一起）、
 *   跨考試污染（獸醫 104090 裝的是藥師藥物治療學的題）。
 * 三種缺題盤點全都抓不到，因為題數永遠是滿的。唯一能抓到的方法就是
 * 拿題幹去比對原卷，算命中率。正常的卷實測都在 79% 以上，壞掉的卷是 0~35%。
 *
 * 另外會回報「題號偏移」：題幹對得上整張卷、但對不上自己那個題號——
 * 這種卷答案多半是錯的（答案是照題號抄的）。
 *
 * 用法：
 *   node scripts/audit-paper-alignment.js --exam nursing
 *   node scripts/audit-paper-alignment.js --exam nursing --min 0.5
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve')
const { pdfStems } = require('./lib/moex-pdf-parse')
const { skeleton } = require('./lib/moex-normalize')
const { warnZero, summary } = require('./lib/coverage-guard')

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d }
const EXAM = arg('--exam')
const MIN = +arg('--min', '0.5')
if (!EXAM) { console.error('需要 --exam'); process.exit(1) }
const FILE = path.join(__dirname, '..', EXAM === 'doctor1' ? 'questions.json' : `questions-${EXAM}.json`)

const key = q => skeleton(q.question).replace(/^【題組情境】/, '').slice(0, 18)

;(async () => {
  const j = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  const arr = j.questions || j
  const papers = new Map()
  for (const q of arr) {
    if (!q.exam_code || !q.subject) continue
    const k = `${q.exam_code}|${q.subject}`
    if (!papers.has(k)) papers.set(k, { exam: EXAM, code: String(q.exam_code), subject: q.subject, year: q.roc_year, items: [] })
    papers.get(k).items.push(q)
  }

  const broken = [], shifted = []
  let checked = 0, unresolved = 0, unparsed = 0
  for (const p of papers.values()) {
    const cand = await resolvePaper(p)
    if (!cand) { unresolved++; continue }
    let stems
    try { const b = await fetchSheet('Q', p.code, cand.c, cand.s); if (!b) { unresolved++; continue }; stems = await pdfStems(b) } catch { unresolved++; continue }
    // 護欄：原卷解析不出足夠題數時,任何命中率都沒有意義。
    // 護理師有些卷 pdfStems 只抓到 1 題,照樣算就會得到「整卷命中 74%、同題號 0%」
    // 這種自相矛盾的假警報,反而把真正的問題埋掉。
    if (stems.size < p.items.length * 0.5) { unparsed++; continue }
    checked++
    const all = [...stems.values()].join('|')
    let inPaper = 0, atNumber = 0, usable = 0
    for (const q of p.items) {
      const s = key(q)
      if (s.length < 14) continue
      usable++
      if (all.includes(s)) inPaper++
      const own = stems.get(+q.number)
      if (own && own.includes(s)) atNumber++
    }
    if (!usable) continue
    const rate = inPaper / usable, numRate = atNumber / usable
    if (rate < MIN) broken.push({ ...p, rate, numRate, usable })
    else if (numRate < rate - 0.25) shifted.push({ ...p, rate, numRate, usable })
  }

  console.log(`${EXAM}：檢查 ${checked} 卷（${unresolved} 卷反查不到／抓不到試題卷，${unparsed} 卷原卷解析不足無法判斷）`)
  console.log(`\n⚠️ 內容對不上原卷（命中率 < ${MIN * 100}%）：${broken.length} 卷`)
  for (const b of broken) console.log(`  ${b.code} ${b.subject}  命中 ${(b.rate * 100).toFixed(0)}%  (${b.usable} 題)`)
  console.log(`\n⚠️ 題號偏移（題在這張卷上、但不在自己的題號）：${shifted.length} 卷`)
  for (const s of shifted) console.log(`  ${s.code} ${s.subject}  整卷命中 ${(s.rate * 100).toFixed(0)}% 但同題號只有 ${(s.numRate * 100).toFixed(0)}%`)
  fs.writeFileSync(path.join(__dirname, '..', '_tmp', `alignment-${EXAM}.json`), JSON.stringify({ broken, shifted }, null, 2))
  warnZero(`${EXAM} 對齊體檢`, checked, '整個考試都反查不到科目——檢查 SUBJECT_ALIASES 與類科碼')
  process.exitCode = summary()
})()
