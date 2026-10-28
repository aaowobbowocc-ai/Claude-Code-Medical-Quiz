#!/usr/bin/env node
/**
 * 把學測／分科題組的「題文」補回既有題目，並修掉被選項吞掉的尾巴。
 *
 * 起因：使用者回報 111 學測社會與國文「題組沒有敘述只有題目，根本無法回答；
 * 好一點的狀況是題目敘述出現在後續的答案裡」。
 *
 * 根因在 scrape-ceec.js 的 parseQuestions：它只在看到行首「N.」時才開新區塊，
 * 題組的題文完全沒處理 —— 在第一題之前的被丟掉，夾在兩題之間的被接到
 * **前一題**，再被選項的正規表示式吃進最後一個選項。已在那支修掉。
 *
 * 但爬蟲是**依 id 合併、跳過已存在的**，重跑不會修到舊資料，所以要這支：
 * 用修好的 parser 重新解析原卷，就地補 passage、就地修選項，保留 id。
 *
 * 四道閘（都不猜內容）：
 *   1. 題幹要對得上（正規化後互為前綴）——確認是同一題
 *   2. 已經有【題組情境】的跳過（冪等）
 *   3. 選項只在「既有的比新的長、而且新的是舊的前綴」時才改
 *      （代表舊的多吞了東西，不是內容不同）
 *   4. 題文長度 20~3000 字才採用
 *
 *   node scripts/repair-ceec-passages.js --exam=gsat --year=111
 *   node scripts/repair-ceec-passages.js --exam=gsat            # 全年份
 *   加 --apply 才寫入
 */
const fs = require('fs')
const path = require('path')
const https = require('https')
const pdfParse = require('pdf-parse')
const { REGISTRY, BASE, parseQuestions } = require('./scrape-ceec.js')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1]
const ONLY_EXAM = arg('exam')
const ONLY_YEAR = arg('year')
const MARK = '【題組情境】'
const L = ['A', 'B', 'C', 'D']

const norm = s => String(s || '').replace(/\s+/g, '')

function download(url, redirects = 0) {
  return new Promise((res, rej) => {
    const full = url.startsWith('http') ? url : BASE + url
    https.get(full, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && redirects < 5) {
        return res(download(new URL(r.headers.location, full).href, redirects + 1))
      }
      if (r.statusCode !== 200) return rej(new Error('HTTP ' + r.statusCode))
      const bufs = []
      r.on('data', d => bufs.push(d)).on('end', () => res(Buffer.concat(bufs)))
    }).on('error', rej)
  })
}

;(async () => {
  let addedPassage = 0, fixedOption = 0
  const skip = {}
  const bump = k => { skip[k] = (skip[k] || 0) + 1 }

  for (const [examId, def] of Object.entries(REGISTRY)) {
    if (ONLY_EXAM && examId !== ONLY_EXAM) continue
    const file = path.join(BK, def.outputFile)
    if (!fs.existsSync(file)) { console.warn(`${def.outputFile} 不存在`); continue }
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    const arr = j.questions || j
    let touched = false

    for (const [year, subjects] of Object.entries(def.years)) {
      if (ONLY_YEAR && year !== ONLY_YEAR) continue
      for (const sd of def.subjects) {
        const urls = subjects[sd.tag]
        if (!urls || !urls.q) continue
        const code = `${examId}_${year}`
        const mine = arr.filter(q => q.exam_code === code && q.subject === sd.name)
        if (!mine.length) continue

        let parsed
        try {
          parsed = parseQuestions((await pdfParse(await download(urls.q))).text)
        } catch (e) { console.warn(`  ${code} ${sd.name}: 原卷取不到（${e.message}）`); continue }
        const byNum = new Map(parsed.map(p => [p.num, p]))

        let a = 0, o = 0
        for (const q of mine) {
          const p = byNum.get(Number(q.number))
          if (!p) { bump('原卷解析不到這題號'); continue }

          // 閘 1：題幹要對得上（去掉既有的題組情境前綴再比）
          const mineStem = norm(String(q.question).replace(/^【題組情境】[\s\S]*?(?=\S)/, ''))
          const theirs = norm(p.question)
          const stemOk = mineStem.startsWith(theirs.slice(0, 18)) || theirs.startsWith(mineStem.slice(0, 18))
          if (!stemOk) { bump('題幹對不上，不是同一題'); continue }

          // ── 補題文 ──
          if (p.passage && p.passage.length >= 20 && p.passage.length <= 3000) {
            if (String(q.question).includes(MARK)) bump('已有題組情境，跳過')
            else {
              if (APPLY) q.question = `${MARK}${p.passage}\n\n${q.question}`
              a++; addedPassage++; touched = true
            }
          }

          // ── 修被吞掉的選項 ──
          for (const k of L) {
            const was = String(q.options?.[k] || '')
            const now = String(p.options?.[k] || '')
            if (!was || !now) continue
            if (norm(was) === norm(now)) continue
            // 只在「舊的比新的長，而且新的是舊的前綴」時才改
            if (norm(was).length > norm(now).length && norm(was).startsWith(norm(now))) {
              if (APPLY) q.options[k] = now
              o++; fixedOption++; touched = true
            } else bump('選項差異不是「多吞了東西」，不動')
          }
        }
        if (a || o) console.log(`  ${code} ${sd.name}：補題文 ${a} 題，修選項 ${o} 個（共 ${mine.length} 題）`)
      }
    }
    if (touched && APPLY) fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n', 'utf8')
  }

  console.log(`\n補題文 ${addedPassage} 題｜修選項 ${fixedOption} 個${APPLY ? '' : '（dry-run）'}`)
  if (Object.keys(skip).length) console.log('跳過：' + JSON.stringify(skip))
  if (APPLY && (addedPassage || fixedOption)) console.log('✅ 已寫回')
})().catch(e => { console.error(e.stack); process.exit(1) })
