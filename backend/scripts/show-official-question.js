#!/usr/bin/env node
/**
 * 把某一題在考選部原卷**全文**裡的前後文印出來。
 *
 * 給「parser 解不出選項、要人工判讀」的題用。paperQuestions() 失敗時
 * 不代表卷子沒有那題，通常是版型變體或選項被圖/公式打斷
 * （[[reference_moex_parser_variants]]）。這支不解析，只定位 + 印原文。
 *
 *   node scripts/show-official-question.js --exam=medlab --code=109020 \
 *     --subject=微生物學與臨床微生物學 --number=5 [--span=420]
 *
 * 定位方式：先用題號 + 題幹前幾個字找；找不到就退回用題庫題幹的任一片段找。
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { resolvePaper, fetchSheet, pdfText } = require('./lib/moex-paper-resolve')

const BK = path.join(__dirname, '..')
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=')
const FILE = e => path.join(BK, e === 'doctor1' ? 'questions.json' : `questions-${e}.json`)

;(async () => {
  const exam = arg('exam'), code = arg('code'), subject = arg('subject')
  const number = Number(arg('number')), span = Number(arg('span') || 420)
  if (!exam || !code || !subject || !number) {
    console.error('缺參數：--exam --code --subject --number [--span]')
    process.exit(1)
  }
  const arr = (j => j.questions || j)(JSON.parse(fs.readFileSync(FILE(exam), 'utf8')))
  const items = arr.filter(q => String(q.exam_code) === String(code) && q.subject === subject)
  const q = items.find(x => +x.number === number)
  if (!q) { console.error('題庫裡找不到這題'); process.exit(1) }

  const p = await resolvePaper({ exam, code: String(code), subject, year: String(items[0].roc_year), items })
  if (!p) { console.error('resolvePaper 失敗'); process.exit(1) }
  const T = (await pdfText(await fetchSheet('Q', String(code), p.c, p.s))).replace(/\s+/g, '')

  console.log(`resolve → c=${p.c} s=${p.s} hitRate=${p.hitRate}`)
  console.log(`題庫題幹：${String(q.question).replace(/\s+/g, ' ').slice(0, 90)}`)
  console.log(`題庫答案：${q.answer}`)
  console.log('')

  // 先用題幹前幾個字定位（最可靠），不行再用題號
  const stem = String(q.question).replace(/\s+/g, '')
  let i = -1
  for (const n of [14, 10, 8, 6]) {
    i = T.indexOf(stem.slice(0, n))
    if (i >= 0) break
  }
  if (i < 0) {
    const m = T.match(new RegExp('(?:^|[^0-9])' + number + '[.．]?'))
    i = m ? T.indexOf(m[0]) : -1
  }
  if (i < 0) { console.error('在原卷全文裡定位不到這題'); process.exit(1) }
  console.log('─── 原卷全文 ───')
  console.log(T.slice(Math.max(0, i - 40), i + span))
})().catch(e => { console.error(e.stack); process.exit(1) })
