#!/usr/bin/env node
/**
 * 英文克漏字／閱讀測驗題組的題幹吃到**下一組**的引文。
 *
 * 徵狀（customs 107050 英文實測）：
 *   #8  題幹 = （閱讀測驗）第 8~10 組的文章 + 8/9/10 三題的選項 +
 *              「請依下文回答第11 題至第15 題」 + 第 11~15 組的文章 + 它們的選項 …
 *              一路吃到卷末，2,700 字。
 *   #10 題幹 = 只剩尾巴「locals providers farmers chefs 請依下文回答第11 題…」
 *   #11-14 題幹 = 空的（被標 empty_question）
 *
 * 成因是切題組時沒有在「下一段宣告」收手 —— 那一段的宣告與引文屬於下一組，
 * 留在這一題裡只會讓使用者讀到不相干的文章。全站 68 題（customs 22、police4 19、
 * railway-transport 15、railway-admin 11、police 1）。
 *
 * 兩種修法，依該卷既有的慣例決定：
 *
 *   A. 題幹內嵌引文（customs）—— 直接用 fill-passage-context 的 passages() 重建：
 *      「（閱讀測驗）<標好空格的引文> | 第 N 題：選出最適合的答案」。
 *      重建而不是裁切，因為裁切留不下乾淨的結果（開頭還黏著上一題的選項）。
 *   B. 引文放 case_context（police4／railway）—— 只在宣告處裁斷。
 *      那一卷的引文本來就在另一個欄位，題幹不該有引文。
 *
 * ⚠️ 每一卷都有護欄：重建前先拿**同一卷已經正確的題**驗一次，
 *    recompute 出來的字串必須和現況一致，不一致就整卷跳過（印出原因）。
 *    沒有可驗的樣本時只做 B（裁切），不做 A（重建）。
 *
 *   node scripts/repair-cloze-group-stems.js [--exam=customs]
 *   node scripts/repair-cloze-group-stems.js --apply
 */
const fs = require('fs')
const path = require('path')
const { resolvePaper } = require('./lib/moex-paper-resolve')
const { paperLines, passages, markBlanks } = require('./fill-passage-context')
const { skeleton } = require('./lib/moex-normalize')
const { atomicWriteJson } = require('./lib/atomic-write')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1]

// 下一組宣告的起點。fill-passage-context 的 DECL 是用來「找宣告」的，
// 這裡要的是「從宣告那個字開始砍掉」，所以自己留一份、只取起始位置。
const DECL_AT = /(?:請)?依下[文列]回答第\s*\d{1,3}\s*題至第?\s*\d{1,3}\s*題/

const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
const show = s => JSON.stringify(norm(s).length > 150 ? norm(s).slice(0, 75) + ' … ' + norm(s).slice(-60) : norm(s))

// 題幹內嵌引文的卷，組題的題幹長這樣（customs 既有慣例）
const embedded = (body, n) => `（閱讀測驗）${body} | 第 ${n} 題：選出最適合的答案`

;(async () => {
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f) && !/\.bak/.test(f))
  let nFix = 0, nSkip = 0, nPaper = 0
  const notes = []

  for (const f of files) {
    const exam = f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '')
    if (only && exam !== only) continue
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'))
    const arr = Array.isArray(j) ? j : j.questions
    if (!arr) continue
    if (!arr.some(q => DECL_AT.test(String(q.question || '')))) continue

    const groups = {}
    for (const q of arr) {
      if (!DECL_AT.test(String(q.question || ''))) continue
      const k = q.exam_code + '|' + q.subject
      groups[k] = true
    }
    let dirty = false

    for (const k of Object.keys(groups)) {
      const [code, ...rest] = k.split('|')
      const subject = rest.join('|')
      const items = arr.filter(q => String(q.exam_code) === code && String(q.subject) === subject)
      let ps
      try {
        const p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items })
        if (!p) { notes.push(`${exam} ${code} ${subject}：對不到官方卷，跳過`); nSkip += items.filter(q => DECL_AT.test(String(q.question || ''))).length; continue }
        ps = passages(await paperLines(code, p.c, p.s))
      } catch (e) { notes.push(`${exam} ${code} ${subject}：抓卷失敗 ${e.message}`); continue }
      if (!ps.length) { notes.push(`${exam} ${code} ${subject}：解不出題組引文，跳過`); continue }
      nPaper++

      // 這一卷是不是「題幹內嵌引文」的慣例？看有沒有以（閱讀測驗）開頭的題。
      const embeddedStyle = items.some(q => /^（閱讀測驗）/.test(String(q.question || '')))

      // 護欄：不要求「有一題完全健康」—— 整卷都壞掉時就驗不了。
      // 改驗**前綴**：被污染的題幹開頭仍然是「（閱讀測驗）+ 本組引文」，
      // 髒的是尾巴。前綴對得上就證明 passages() 解出來的引文與題庫同源，
      // 重建公式可信（customs 107050 #8 實測：706 字前綴完全相同）。
      // 尾巴的「| 第 N 題：…」是既有慣例，從污染字串的最後面原樣撈回來。
      let gateOk = false, gateWhy = '非內嵌慣例，只做裁切', suffix = ''
      if (embeddedStyle) {
        for (const g of ps) {
          for (const it of items) {
            const n = +it.number
            if (n < g.from || n > g.to) continue
            const cur = norm(it.question)
            if (!cur.startsWith(norm('（閱讀測驗）' + g.passage))) continue
            gateOk = true
            gateWhy = `以 #${n} 的 ${norm('（閱讀測驗）' + g.passage).length} 字前綴驗過引文同源`
            const sm = /\|\s*第\s*\d{1,3}\s*題[：:][^|]*$/.exec(cur)
            if (sm) suffix = sm[0].replace(/第\s*\d{1,3}\s*題/, '第 {N} 題')
          }
        }
        if (!gateOk) gateWhy = '引文與題庫對不起來，不敢重建，只做裁切'
      }

      for (const q of items) {
        const cur = String(q.question || '')
        const n = +q.number
        const g = ps.find(x => n >= x.from && n <= x.to)
        const broken = DECL_AT.test(cur) || !cur.trim()
        if (!broken) continue

        let next = null, how = ''
        if (embeddedStyle && gateOk && g) {
          // 空格用裸題號（「This very dangerous 8 takes place」），跟這一卷現有的寫法一致。
          // markBlanks 會改成 __8__，比較好讀，但那是另一件事，不要混在這支裡改。
          next = `（閱讀測驗）${g.passage}${suffix ? ' ' + suffix.replace('{N}', n) : ''}`
          how = `重建（第 ${g.from}~${g.to} 組共用引文）`
        }
        if (next === null) {
          const m = DECL_AT.exec(cur)
          if (!m) continue                                    // 空題幹又不能重建 → 留著
          next = cur.slice(0, m.index).trim()
          how = '裁切到下一組宣告之前'
          // 裁完只剩「play enjoy thank dislike」「at least at once at hand at present」這種——
          // 那是**上一題的選項**，根本不屬於這一題。克漏字題本來就沒有自己的題幹
          // （空格在引文裡，case_context 已經標好「本題問第 N 格」），所以正確的題幹是空的。
          // 判準：沒有空格底線、沒有問號、又短——三個都中才算殘渣。
          const looksLikeQuestion = /_{3,}|[?？]/.test(next) || skeleton(next).length >= 60
          if (!looksLikeQuestion) {
            // ❗ 只有**克漏字**題可以清空。閱讀測驗題每一題都有自己的問句
            //   （「Which of the following best describes…」），清空等於把題目弄掉。
            //   那種的真正問句根本沒被抓下來，要另外補，不是這支的事。
            const isCloze = g && markBlanks(g.passage, g.from, g.to).marked > 0
            if (!isCloze) { nSkip++; notes.push(`${exam} ${code} #${n}：閱讀測驗題，裁完沒有問句可留（真正的問句未抓到），跳過`); continue }
            if (!q.case_context) { nSkip++; notes.push(`${exam} ${code} #${n}：裁切後只剩 ${JSON.stringify(norm(next))}，而且沒有 case_context 引文可依，不敢寫`); continue }
            next = ''
            how = '清空（裁完只剩上一題的選項；克漏字題的內容在 case_context）'
          }
        }
        if (norm(next) === norm(cur)) continue

        console.log(`\n── ${exam} ${code} ${subject} #${n}   ${how}`)
        console.log(`   舊[${norm(cur).length}字] ${show(cur)}`)
        console.log(`   新[${norm(next).length}字] ${show(next)}`)
        if (APPLY) { q.question = next; if (q.incomplete === 'empty_question') delete q.incomplete; dirty = true }
        nFix++
      }
      if (gateWhy) console.log(`   （${exam} ${code}：${gateWhy}）`)
    }
    if (APPLY && dirty) atomicWriteJson(path.join(BK, f), j)
  }

  console.log(`\n${nPaper} 卷｜${APPLY ? '已修' : '可修'} ${nFix} 題${nSkip ? `｜跳過 ${nSkip}` : ''}`)
  if (notes.length) console.log('備註：\n  ' + notes.join('\n  '))
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)')
})().catch(e => { console.error(e.stack); process.exit(1) })
