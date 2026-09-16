#!/usr/bin/env node
/**
 * 修 dental2（牙醫師二階）110 年起「卷一/卷二/卷四 三張卷被重新切過」。
 *
 * 怎麼發現的：掃更正答案時這些卷反查不到科目，追下去發現我們的一張「卷」裡
 * 混了兩張考選部的卷。以 110020 卷一為例：#1~28 其實出自牙醫學(三)、
 * #29~80 出自牙醫學(四)。整個場次的題目一題不少，只是被當成連續 320 題
 * 重新切成四段各 80 題，於是卷別與題號全錯位（卷三剛好沒被影響）。
 *
 * 影響：使用者選「卷一」練習會拿到別卷的題；更正答案／爭議題比對整批對不上。
 *
 * 修法：用考選部試題卷的題幹反查每一題真正的出處與題號，就地改 subject 與 number。
 *   - 不刪列、不新增，id 不動（使用者的錯題夾才不會失聯）。
 *   - subject_tag / subject_name 沿用「乾淨場次」同卷同題號的值：這個考試的
 *     子科目標籤本來就是依題號區間套的固定模板（#1-28、#29-68、#69-80），
 *     不是逐題判斷的，所以改完題號後要照模板重新對齊。
 *   - 答案只驗不改：比對「我們的答案選項文字」與「官方答案選項文字」，
 *     有出入只列出來，不自動改（選項順序與原卷不同，字母比對無效）。
 *
 * 用法：
 *   node scripts/fix-dental2-paper-split.js              # dry-run + 驗答案
 *   node scripts/fix-dental2-paper-split.js --apply
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { probeCodes, fetchSheet } = require('./lib/moex-paper-resolve')
const { pdfStems, pdfOptions } = require('./lib/moex-pdf-parse')
const { parseAnswerSheet } = require('./lib/moex-answer-sheet')
const { skeleton } = require('./lib/moex-normalize')
const { warnZero, summary } = require('./lib/coverage-guard')

const APPLY = process.argv.includes('--apply')
const FILE = path.join(__dirname, '..', 'questions-dental2.json')
// 我們的卷別 ↔ 考選部科目。順序固定，乾淨場次 80/80 驗證過。
const VOL = [['卷一', '三'], ['卷二', '四'], ['卷三', '五'], ['卷四', '六']]

async function loadPaper(code, c, s) {
  const qb = await fetchSheet('Q', code, c, s)
  if (!qb) return null
  const stems = await pdfStems(qb)
  let answers = {}
  const sb = await fetchSheet('S', code, c, s)
  if (sb) { try { answers = await parseAnswerSheet(sb) } catch {} }
  let opts = new Map()
  try { opts = await pdfOptions(qb) } catch {}
  return { stems, answers, opts }
}

async function main() {
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  const arr = data.questions || data

  // 子科目模板：(卷, 題號) → { tag, name }，取自任一乾淨場次
  const template = new Map()
  for (const q of arr) {
    const k = `${q.subject}|${q.number}`
    if (!template.has(k) && q.subject_tag) template.set(k, { tag: q.subject_tag, name: q.subject_name })
  }

  const codes = [...new Set(arr.map(q => String(q.exam_code)).filter(Boolean))].sort()
  let fixedTotal = 0, sessionsFixed = 0, answerMismatch = []

  for (const code of codes) {
    const year = code.slice(0, 3)
    const cands = probeCodes(code, year).filter(x => /^牙醫學[（(][三四五六]/.test(x.subject))
    if (!cands.length) continue

    // 同一場次可能有兩個類科開同名科目（c=302 與 c=303），先用題幹命中數挑出我們這一份
    const papers = new Map()
    for (const [, cn] of VOL) {
      const same = cands.filter(x => x.subject.slice(3, 4) === cn || x.subject.includes(`(${cn})`) || x.subject.includes(`（${cn}）`))
      let best = null
      for (const cand of same) {
        const p = await loadPaper(code, cand.c, cand.s)
        if (!p) continue
        const all = [...p.stems.values()].join('|')
        const ours = arr.filter(q => String(q.exam_code) === code)
        let hit = 0
        for (const q of ours) { const s = skeleton(q.question).slice(0, 20); if (s.length >= 12 && all.includes(s)) hit++ }
        if (!best || hit > best.hit) best = { hit, p }
      }
      if (best && best.hit > 0) papers.set(cn, best.p)
    }
    if (papers.size < VOL.length) { console.log(`  ${code}: 只取到 ${papers.size}/4 張卷，跳過`); continue }

    // 只處理真的被錯切的場次。110 年以前的場次卷別本來就對，
    // 拿題幹逐題比對反而會被「下圖中有何種病變？」這類重複題幹帶偏。
    const rows = arr.filter(q => String(q.exam_code) === code)
    const per = rows.length / VOL.length
    const volIdx = new Map(VOL.map(([v], i) => [v, i]))
    const ordered = [...rows].sort((a, b) => (volIdx.get(a.subject) ?? 9) - (volIdx.get(b.subject) ?? 9) || a.number - b.number)
    if (ordered.length !== VOL.length * per) { continue }

    // 每題的候選出處（可能 0、1 或多筆）
    const paperList = VOL.map(([, cn]) => ({ cn, p: papers.get(cn) }))
    const cand = ordered.map(q => {
      const s = skeleton(q.question).slice(0, 26)
      const hits = []
      if (s.length >= 16) {
        paperList.forEach((pp, pi) => { for (const [num, stem] of pp.p.stems) if (stem.includes(s)) hits.push({ pi, num }) })
      }
      if (hits.length === 1) return hits
      // 題幹對不到（純圖題）或撞名時改用選項比對：四個選項有三個對得上就算同一題。
      // 選項是逐題獨立的文字，比題幹前綴可靠得多。
      const ours = ['A', 'B', 'C', 'D'].map(k => skeleton((q.options || {})[k] || '')).filter(x => x.length >= 4)
      if (ours.length < 3) return hits
      const byOpts = []
      paperList.forEach((pp, pi) => {
        for (const [num, opts] of pp.p.opts) {
          const theirs = opts.map(o => skeleton(o)).filter(Boolean)
          if (theirs.length < 3) continue
          let same = 0
          for (const a of ours) if (theirs.some(b => a === b || a.includes(b) || b.includes(a))) same++
          if (same >= 3) byOpts.push({ pi, num })
        }
      })
      return byOpts.length === 1 ? byOpts : hits
    })

    // 錯切是「整段搬移、順序不變」，所以 (我們的第 i 題) → (第 pi 卷的第 num 題)
    // 在每一段裡都是 num = i + 常數。先用唯一命中的題投票找出每一段的常數，
    // 再用段去推整段的題號——這樣純圖題、題幹重複的題也一起定位，
    // 不必逐題硬猜，也不會因為少數幾題對不上就整場放棄。
    const seg = new Array(ordered.length).fill(null)
    for (let i = 0; i < ordered.length; i++) {
      if (cand[i].length === 1) seg[i] = { pi: cand[i][0].pi, k: cand[i][0].num - i }
    }
    // 多筆命中的，挑與鄰近段一致的那筆
    for (let i = 0; i < ordered.length; i++) {
      if (seg[i] || cand[i].length < 2) continue
      for (let d = 1; d <= 5 && !seg[i]; d++) {
        for (const j of [i - d, i + d]) {
          const ref = seg[j]
          if (!ref) continue
          const m = cand[i].find(h => h.pi === ref.pi && h.num - i === ref.k)
          if (m) { seg[i] = { pi: m.pi, k: m.num - i }; break }
        }
      }
    }
    // 把確定的點收成「連續段」，段與段之間的空洞再依題號界線分派。
    // 界線是算得出來的：前一段的題號一旦要超過 per 就不可能還是同一卷，
    // 後一段的題號一旦小於 1 也不可能。所以空洞不是用猜的。
    const runs = []
    for (let i = 0; i < ordered.length; i++) {
      const sgm = seg[i]
      if (!sgm) continue
      const last = runs[runs.length - 1]
      if (last && last.pi === sgm.pi && last.k === sgm.k) { last.to = i; last.n++ }
      else runs.push({ pi: sgm.pi, k: sgm.k, from: i, to: i, n: 1 })
    }
    // 票數 1~2 的段幾乎都是題幹撞名造成的假段，併回鄰居。
    // 還要排除互相重疊的段：同一批題不可能同時屬於兩段，票多的那段才是真的。
    const accepted = []
    for (const r of runs.filter(r => r.n >= 3).sort((a, b) => b.n - a.n)) {
      if (accepted.some(x => r.from <= x.to && x.from <= r.to)) continue
      accepted.push(r)
    }
    const solid = accepted.sort((a, b) => a.from - b.from)

    const assign = new Array(ordered.length).fill(null)
    const used = new Set()
    const take = (i, r) => { assign[i] = r; used.add(`${r.pi}|${i + r.k}`) }
    for (const r of solid) for (let i = r.from; i <= r.to; i++) take(i, r)

    // 段與段之間的空洞：這幾題屬於前段的尾巴還是後段的開頭，用「不能撞號」來決定。
    // 逐一試切分點，取第一個兩邊題號都合法（1..per）且都沒被佔用的切法。
    // 不用猜規則，因為每張卷剛好 per 題、不重不漏，本來就只有一種切法成立。
    for (let ri = 0; ri < solid.length; ri++) {
      const cur = solid[ri], next = solid[ri + 1]
      const from = cur.to + 1
      const to = next ? next.from - 1 : ordered.length - 1
      if (from > to) continue
      const g = to - from + 1
      let chosen = null
      for (let toCur = g; toCur >= 0 && !chosen; toCur--) {
        if (!next && toCur < g) break                     // 最後一段沒有「後段」可分
        const ok = []
        for (let n = 0; n < g; n++) {
          const i = from + n
          const r = n < toCur ? cur : next
          const num = i + r.k
          if (num < 1 || num > per || used.has(`${r.pi}|${num}`)) { ok.length = 0; break }
          ok.push({ i, r })
        }
        if (ok.length === g) chosen = ok
      }
      if (chosen) for (const { i, r } of chosen) take(i, r)
    }
    // 第一段之前的殘餘（很少見）
    if (solid.length) for (let i = 0; i < solid[0].from; i++) {
      const num = i + solid[0].k
      if (!assign[i] && num >= 1 && !used.has(`${solid[0].pi}|${num}`)) take(i, solid[0])
    }

    const plan = []
    let unresolved = 0
    for (let i = 0; i < ordered.length; i++) {
      const a = assign[i]
      if (!a) { unresolved++; continue }
      const num = i + a.k
      if (num < 1 || num > per) { unresolved++; continue }
      plan.push({ q: ordered[i], vol: VOL[a.pi][0], num, p: paperList[a.pi].p })
    }
    const changed = plan.filter(x => x.q.subject !== x.vol || x.q.number !== x.num)
    if (!changed.length) continue

    // 收尾檢查：必須剛好蓋滿 4 卷 × per 題、不重不漏，否則整場不動。
    const expected = new Set()
    for (const [vol] of VOL) for (let n = 1; n <= per; n++) expected.add(`${vol}|${n}`)
    const finalKeys = plan.map(x => `${x.vol}|${x.num}`)
    const uniq = new Set(finalKeys)
    if (unresolved || uniq.size !== finalKeys.length || uniq.size !== expected.size) {
      console.log(`  ${code}: 段落推導無法蓋滿全場（定位不到 ${unresolved}、重複 ${finalKeys.length - uniq.size}），整場跳過`)
      if (process.argv.includes('--debug')) {
        console.log('     段落: ' + solid.map(r => `[${r.from}-${r.to}]→卷${r.pi + 1}#${r.from + r.k} (票${r.n})`).join(' '))
        console.log('     重複: ' + [...new Set(finalKeys.filter((k, i) => finalKeys.indexOf(k) !== i))].join(' '))
      }
      continue
    }

    // 答案只驗不改
    for (const x of plan) {
      const off = x.p.answers[x.num]
      const o = x.p.opts.get(x.num)
      if (!off || !o || !/^[A-D]$/.test(String(off).trim())) continue
      const ourTxt = skeleton((x.q.options || {})[x.q.answer] || '')
      const offTxt = skeleton(o['ABCD'.indexOf(String(off).trim())] || '')
      if (!ourTxt || !offTxt) continue
      if (!(ourTxt.includes(offTxt) || offTxt.includes(ourTxt))) {
        answerMismatch.push(`${code} ${x.vol}#${x.num} 我們=${x.q.answer}:${ourTxt.slice(0, 20)} 官方=${off}:${offTxt.slice(0, 20)}`)
      }
    }

    if (APPLY) {
      for (const x of plan) {
        x.q.subject = x.vol
        x.q.number = x.num
        const t = template.get(`${x.vol}|${x.num}`)
        if (t) { x.q.subject_tag = t.tag; x.q.subject_name = t.name }
      }
    }
    console.log(`  ${code}: 修正 ${changed.length}/${rows.length} 題的卷別與題號`)
    fixedTotal += changed.length
    sessionsFixed++
  }

  console.log(`\n共 ${sessionsFixed} 場、${fixedTotal} 題${APPLY ? '已修正' : '待修正（dry-run）'}`)
  if (answerMismatch.length) {
    console.log(`\n⚠️ 答案與官方對不上 ${answerMismatch.length} 題（只列出，未自動改）：`)
    answerMismatch.slice(0, 20).forEach(x => console.log('   ' + x))
  } else {
    console.log('✅ 抽驗過的題目答案全部與考選部一致')
  }
  warnZero('dental2 卷別重建', fixedTotal, '所有場次都已對齊，或試題卷抓不到')
  if (APPLY && fixedTotal) {
    if (data.metadata) data.metadata.last_updated = new Date().toISOString()
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n')
    console.log('✅ 已寫回 questions-dental2.json')
  }
  process.exitCode = summary()
}
main().catch(e => { console.error(e); process.exit(1) })
