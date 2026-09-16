#!/usr/bin/env node
/**
 * 用考選部原卷「就地覆寫」某一場（或某一卷）的題目。
 *
 * 用在「題數是滿的、內容卻是別人的」這類事故：
 *   - 藥師一階 106~109 卷一整卷是卷三的複製品
 *   - 獸醫 104090 五張卷裝的是藥師「藥物治療學」的題目（跨考試污染）
 * 這種事故缺題盤點抓不到（題數滿的），只有拿題幹去比對原卷才看得出來。
 *
 * 為什麼是「覆寫」不是「刪掉重建」：
 *   刪掉再新增會換掉 question id，使用者的錯題夾、作答紀錄會整批失聯。
 *   所以照題號一對一覆寫，id 原封不動。
 *
 * 安全機制：
 *   - 先算命中率（我們的題幹有多少出現在原卷裡）。高於 --max-hit 就拒絕動手，
 *     避免把好卷覆蓋掉。預設 0.3：正常的卷實測都在 79% 以上。
 *   - 選項必須四個齊全、且不能帶「A.」標記，否則該題標 incomplete 不硬寫。
 *   - 覆寫時清掉 explanation 與 disputed（那是在描述舊的、錯的題目）。
 *
 * 用法：
 *   node scripts/rebuild-paper-from-moex.js --exam vet --code 104090            # dry-run
 *   node scripts/rebuild-paper-from-moex.js --exam vet --code 104090 --apply
 *   加 --subject 只做一張卷；加 --max-hit 0.5 放寬保護
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { probeCodes, nameCandidates, fetchSheet } = require('./lib/moex-paper-resolve')
const { pdfQuestions } = require('./lib/moex-pdf-parse')
const { parseAnswerSheet } = require('./lib/moex-answer-sheet')
const { skeleton } = require('./lib/moex-normalize')
const { warnZero, summary } = require('./lib/coverage-guard')

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d }
const EXAM = arg('--exam')
const CODE = arg('--code')
const ONLY = arg('--subject')
const MAX_HIT = +arg('--max-hit', '0.3')
const APPLY = process.argv.includes('--apply')
if (!EXAM || !CODE) { console.error('需要 --exam 與 --code'); process.exit(1) }

const FILE = path.join(__dirname, '..', EXAM === 'doctor1' ? 'questions.json' : `questions-${EXAM}.json`)

async function main() {
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  const arr = data.questions || data
  const rows = arr.filter(q => String(q.exam_code) === CODE && (!ONLY || q.subject === ONLY))
  if (!rows.length) { console.error(`找不到 ${EXAM} ${CODE}${ONLY ? ' ' + ONLY : ''} 的題目`); process.exit(1) }

  const subjects = [...new Set(rows.map(q => q.subject))]
  const codes = probeCodes(CODE, CODE.slice(0, 3))
  let replaced = 0, stranded = 0, skippedPapers = 0

  for (const sub of subjects) {
    const it = rows.filter(q => q.subject === sub).sort((a, b) => a.number - b.number)
    const { list: cands } = nameCandidates(EXAM, sub, codes)
    if (!cands.length) { console.log(`  ${sub}: 反查不到科目，跳過`); skippedPapers++; continue }

    let picked = null
    for (const c of cands) {
      let off
      try { const b = await fetchSheet('Q', CODE, c.c, c.s); if (!b) continue; off = await pdfQuestions(b) } catch { continue }
      if (!off.size) continue
      const all = [...off.values()].map(x => skeleton(x.stem)).join('|')
      let hit = 0
      for (const q of it) {
        const s = skeleton(q.question).replace(/^【題組情境】/, '').slice(0, 18)
        if (s.length >= 14 && all.includes(s)) hit++
      }
      const rate = hit / it.length
      if (!picked || rate < picked.rate) picked = { c, off, rate }   // 命中率最低＝最需要重建
    }
    if (!picked) { console.log(`  ${sub}: 試題卷抓不到，跳過`); skippedPapers++; continue }
    if (picked.rate > MAX_HIT) {
      console.log(`  ${sub}: 命中率 ${(picked.rate * 100).toFixed(0)}% > ${MAX_HIT * 100}%，這卷看起來是好的，不動`)
      skippedPapers++; continue
    }

    let answers = {}
    try { const sb = await fetchSheet('S', CODE, picked.c.c, picked.c.s); if (sb) answers = await parseAnswerSheet(sb) } catch {}

    let n = 0, bad = 0
    for (const q of it) {
      const src = picked.off.get(q.number)
      const ans = answers[q.number]
      const o = src ? { A: src.options[0], B: src.options[1], C: src.options[2], D: src.options[3] } : {}
      const clean = ['A', 'B', 'C', 'D'].every(k => o[k] && o[k].trim() && !/^[A-D]\s*[.．、]/.test(o[k]))
      if (!src || !ans || !/^[ABCD]$/.test(String(ans)) || !clean) {
        bad++
        if (APPLY) q.incomplete = 'wrong_source_paper'
        continue
      }
      if (APPLY) {
        q.question = String(src.stem).replace(/^[\s.．、]+/, '')
        q.options = o
        q.answer = String(ans)
        q.explanation = ''
        delete q.disputed
        delete q.incomplete
      }
      n++
    }
    console.log(`  ${sub}: 原命中率 ${(picked.rate * 100).toFixed(0)}% → 從 c=${picked.c.c} s=${picked.c.s} 覆寫 ${n}/${it.length}` +
      (bad ? `（${bad} 題換不過來，標 incomplete）` : ''))
    replaced += n; stranded += bad
  }

  console.log(`\n${EXAM} ${CODE}：${replaced} 題${APPLY ? '已覆寫' : '可覆寫（dry-run）'}，${stranded} 題標記 incomplete，${skippedPapers} 卷未處理`)
  warnZero(`${EXAM} ${CODE} 重建`, replaced, '命中率都高於門檻（卷是好的），或反查不到科目')
  if (APPLY && replaced) {
    if (data.metadata) data.metadata.last_updated = new Date().toISOString()
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n')
    console.log(`✅ 已寫回 ${path.basename(FILE)}`)
  }
  process.exitCode = summary()
}
main().catch(e => { console.error(e); process.exit(1) })
