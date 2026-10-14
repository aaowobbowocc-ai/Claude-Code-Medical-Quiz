#!/usr/bin/env node
/**
 * 重建「兩張卷被交錯合併」的卷。
 *
 * 怎麼發現的：醫師一階 106020 醫學(一) 104 題、醫學(二) 96 題，合計 200——
 * 跟其他場次的 100+100 一樣，但各有一半的題幹在自己的原卷上找不到。
 * 逐題去另一張卷找，模式乾淨得嚇人：
 *
 *   醫學(一) 的題號 2,4,6,8,10,…,80 全部是偶數，全部屬於醫學(二)
 *
 * 也就是建庫時把兩張卷交錯著寫進同一個科目。後果不只是分類錯：
 * 練「醫學(一) 解剖／微生物／寄生蟲」的人，有一半拿到的是
 * 「醫學(二) 生理／生化／藥理／病理」的題。
 *
 * 做法：**整卷從原卷重建**，不做逐題搬移——搬移要同時處理題號衝突與
 * 答案對應，比重建更容易出錯。
 *
 * 四道閘：
 *   1. 原卷解析出的題數要 ≥ 預期的 95%
 *   2. 每題四個選項都要乾淨（非空、互不相同）才寫；不乾淨的那題跳過，保留原狀
 *   3. 答案卷讀不到該題號就標 incomplete 隱藏，不猜
 *   4. 寫完逐題算覆蓋率，整卷平均 < 0.9 就整卷回退
 *
 * id 盡量沿用（同科目同題號的舊題），題數變多時才給新 id。
 *
 *   node scripts/rebuild-interleaved-papers.js            # dry-run
 *   node scripts/rebuild-interleaved-papers.js --apply
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { resolvePaper, fetchSheet, pdfText } = require('./lib/moex-paper-resolve')
const { pdfTextClean } = require('./lib/moex-run-overlap')
const { paperQuestions } = require('./fill-civil-gaps')
const { sheetMap } = require('./lib/moex-answer-geo')
const { skeleton } = require('./lib/moex-normalize')
const { atomicWriteJson } = require('./lib/atomic-write')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const L = ['A', 'B', 'C', 'D']
const FILE = e => e === 'doctor1' ? 'questions.json' : `questions-${e}.json`

/** 要重建的卷。發現新的就加進來。 */
const TARGETS = [
  { exam: 'doctor1', code: '106020', subject: '醫學(一)' },
  { exam: 'doctor1', code: '106020', subject: '醫學(二)' },
]

const N = 8
function cover(stem, texts) {
  const k = skeleton(String(stem))
  if (k.length < N + 4) return null
  let hit = 0, tot = 0
  for (let i = 0; i + N <= k.length; i++) { tot++; if (texts.some(T => T.includes(k.slice(i, i + N)))) hit++ }
  return tot ? hit / tot : null
}

;(async () => {
  const cache = {}
  for (const t of TARGETS) {
    const f = FILE(t.exam)
    const j = cache[f] || (cache[f] = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')))
    const arr = j.questions || j
    const old = arr.filter(q => String(q.exam_code) === String(t.code) && q.subject === t.subject)
    if (!old.length) { console.log(`✗ ${t.exam} ${t.code} ${t.subject}：題庫裡沒有`); continue }

    const p = await resolvePaper({ exam: t.exam, code: t.code, subject: t.subject, year: String(old[0].roc_year), items: old })
    if (!p) { console.log(`✗ ${t.exam} ${t.code} ${t.subject}：對不到原卷`); continue }
    const buf = await fetchSheet('Q', t.code, p.c, p.s)
    const texts = [skeleton(await pdfText(buf)), skeleton(await pdfTextClean(buf))]
    const parsed = await paperQuestions(t.code, p.c, p.s)
    const ans = (await sheetMap(t.code, p.c, p.s, Math.max(110, old.length))).map

    const nums = [...parsed.keys()].sort((a, b) => a - b)
    const expect = nums[nums.length - 1]
    console.log(`\n${t.exam} ${t.code} ${t.subject}`)
    console.log(`  原卷「${p.subject.slice(0, 34)}」 解析 ${parsed.size}/${expect} 題｜答案卷 ${ans.size} 題｜題庫現有 ${old.length} 題`)
    if (parsed.size < expect * 0.95) { console.log('  ⊘ 原卷解析不足 95%，整卷不動'); continue }

    const byNum = new Map(old.map(q => [+q.number, q]))
    const proto = old[0]
    let maxId = 0
    for (const q of arr) { const n = Number(q.id); if (Number.isFinite(n) && n > maxId) maxId = n }

    const rebuilt = []
    let kept = 0, dirty = 0, noAns = 0
    for (const n of nums) {
      const o = parsed.get(n)
      const opts = L.map(x => String(o.options[x] || ''))
      const base = byNum.get(n)
      if (opts.some(x => !x.trim()) || new Set(opts).size !== 4) {
        dirty++
        if (base) rebuilt.push(base)          // 原卷這題不乾淨 → 保留題庫原狀
        continue
      }
      const a = ans.get(n)
      const q = base ? { ...base } : { ...proto, id: ++maxId, number: n }
      q.number = n
      q.question = String(o.stem)
      q.options = { A: opts[0], B: opts[1], C: opts[2], D: opts[3] }
      q.explanation = ''
      delete q.disputed
      delete q.images
      delete q.incomplete
      delete q.incomplete_reason
      if (a && /^[ABCD]$/.test(String(a))) q.answer = String(a)
      else { q.incomplete = true; q.incomplete_reason = '重建時答案卷讀不到此題號'; noAns++ }
      if (base) kept++
      rebuilt.push(q)
    }

    // 閘 4：重建後的覆蓋率
    const covs = rebuilt.map(q => cover(q.question, texts)).filter(x => x !== null)
    const avg = covs.reduce((s, x) => s + x, 0) / (covs.length || 1)
    const oldCovs = old.map(q => cover(q.question, texts)).filter(x => x !== null)
    const oldAvg = oldCovs.reduce((s, x) => s + x, 0) / (oldCovs.length || 1)
    console.log(`  重建 ${rebuilt.length} 題（沿用 id ${kept}、新增 ${rebuilt.length - kept}）｜原卷選項不乾淨保留原狀 ${dirty}｜答案讀不到標隱藏 ${noAns}`)
    console.log(`  整卷覆蓋率 ${Math.round(oldAvg * 100)}% → ${Math.round(avg * 100)}%`)
    if (avg < 0.9) { console.log('  ⊘ 重建後覆蓋率仍 < 90%，整卷回退'); continue }
    if (avg <= oldAvg) { console.log('  ⊘ 重建後沒有變好，整卷回退'); continue }

    for (const q of rebuilt.slice(0, 3)) console.log(`    #${q.number} 答${q.answer}  ${String(q.question).replace(/\s+/g, ' ').slice(0, 52)}`)

    if (APPLY) {
      const keepIds = new Set(rebuilt.map(q => String(q.id)))
      const dropped = old.filter(q => !keepIds.has(String(q.id)))
      // 就地取代：從舊題的第一個位置插回去，否則重建的題全被推到檔尾，diff 會爆炸
      const at = arr.findIndex(q => String(q.exam_code) === String(t.code) && q.subject === t.subject)
      for (let i = arr.length - 1; i >= 0; i--) {
        const q = arr[i]
        if (String(q.exam_code) === String(t.code) && q.subject === t.subject) arr.splice(i, 1)
      }
      arr.splice(at < 0 ? arr.length : at, 0, ...rebuilt)
      console.log(`  ✅ 寫入（移除不再對應的舊題 ${dropped.length} 筆）`)
    }
  }

  if (APPLY) {
    for (const [f, j] of Object.entries(cache)) {
      const arr = j.questions || j
      if (j.total !== undefined) j.total = arr.length
      atomicWriteJson(path.join(BK, f), j)
    }
    console.log('\n✅ 已寫回')
  } else {
    console.log('\n（dry-run）')
  }
})().catch(e => { console.error(e.stack); process.exit(1) })
