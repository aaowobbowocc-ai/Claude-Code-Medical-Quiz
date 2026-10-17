#!/usr/bin/env node
/**
 * 補一整張缺的卷。用既有的解析與防呆，不另造輪子。
 *
 * 與 fill-missing-papers.js 的差別：那支把目標寫死在原始碼的 TARGETS 陣列裡、
 * 自己接 pdfjs 解析、id 一律給流水號。這支吃命令列參數，解析走
 * `paperQuestions()` + `lib/moex-marker-options` 後備，而且**沿用該科既有的
 * id 命名慣例**（抓同科目任一題的 id 當樣板，例如 speech_100090_p6_1
 * → speech_115100_p6_N），不會在字串 id 的科目裡混進流水號。
 *
 * 四道閘（與 rebuild-corrupt-stems.js 同一套）：
 *   - 原卷表頭要含指定的考試/科目關鍵字
 *   - 每題四個選項乾淨（清掉 PUA/零寬字元後非空、互不相同）
 *   - 不收含 ___ 的下標殘渣、不收連續三組以上「大寫字母＋數字」
 *   - 答案卷讀不到該題號就標 incomplete，不猜
 *
 *   node scripts/fill-one-paper.js --exam=speech-therapist --code=115100 \
 *     --c=105 --s=0506 --subject=溝通障礙總論 --year=115 --session=第二次 --verify=語言治療師
 *   加 --apply 才寫入。
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { fetchSheet, pdfText } = require('./lib/moex-paper-resolve')
const { paperQuestions } = require('./fill-civil-gaps')
const { markerOptions } = require('./lib/moex-marker-options')
const { sheetMap } = require('./lib/moex-answer-geo')
const { atomicWriteJson } = require('./lib/atomic-write')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=')
const L = ['A', 'B', 'C', 'D']
const FILE = e => e === 'doctor1' ? 'questions.json' : `questions-${e}.json`
const bare = t => String(t).replace(/[-​-‏﻿\s　]/g, '')

;(async () => {
  const exam = arg('exam'), code = arg('code'), c = arg('c'), s = arg('s')
  const subject = arg('subject'), year = arg('year'), session = arg('session') || '第一次'
  const verify = arg('verify')
  if (!exam || !code || !c || !s || !subject || !year) {
    console.error('缺參數：--exam --code --c --s --subject --year [--session] [--verify]')
    process.exit(1)
  }

  const fp = path.join(BK, FILE(exam))
  const j = JSON.parse(fs.readFileSync(fp, 'utf8'))
  const arr = j.questions || j
  if (arr.some(q => String(q.exam_code) === code && q.subject === subject)) {
    console.error(`${exam} ${code} ${subject} 已經有資料，不重複補`)
    process.exit(1)
  }

  const buf = await fetchSheet('Q', code, c, s)
  if (!buf) { console.error('抓不到試題 PDF'); process.exit(1) }
  const head = (await pdfText(buf)).replace(/\s+/g, '').slice(0, 300)
  if (verify && !head.includes(verify)) { console.error(`表頭沒有「${verify}」：${head.slice(0, 90)}`); process.exit(1) }
  if (!head.includes(subject.slice(0, 6))) { console.error(`表頭沒有科目「${subject}」：${head.slice(0, 90)}`); process.exit(1) }
  console.log(`表頭確認：${head.slice(0, 80)}`)

  const parsed = await paperQuestions(code, c, s)
  let marker = null
  try { marker = await markerOptions(buf) } catch {}
  const { map: ans } = await sheetMap(code, c, s, 200)
  console.log(`解析 ${parsed.size} 題｜後備解析 ${marker ? marker.size : 0} 題｜答案卷 ${ans.size} 題`)

  // 同科目既有的 id 樣板，例如 speech_100090_p6_1 → speech_115100_p6_N
  const sib = arr.find(q => q.subject === subject) || arr.find(q => q.subject_tag)
  const mkId = n => {
    if (sib && typeof sib.id === 'string' && /^[a-z]/i.test(sib.id)) {
      const m = String(sib.id).match(/^(.*?)(\d{5,6})(.*?)(\d+)$/)
      if (m) return `${m[1]}${code}${m[3]}${n}`
    }
    const nums = arr.map(q => Number(q.id)).filter(Number.isFinite)
    return (nums.length ? Math.max(...nums) : 0) + n
  }

  const ok = o => o && L.every(k => bare(o.options[k])) && new Set(L.map(k => bare(o.options[k]))).size === 4
  const out = []
  const skip = {}
  const bump = k => { skip[k] = (skip[k] || 0) + 1 }
  for (const n of [...new Set([...parsed.keys(), ...(marker ? marker.keys() : [])])].sort((a, b) => a - b)) {
    let o = parsed.get(n)
    if (!ok(o) && marker && ok(marker.get(n))) o = marker.get(n)
    if (!ok(o)) { bump('選項不乾淨'); continue }
    const opts = L.map(x => String(o.options[x]))
    if (opts.some(x => /_{3,}/.test(x))) { bump('下標炸開'); continue }
    if (opts.some(x => /(?:[A-Z]\d){3,}/.test(x))) { bump('上下標炸開'); continue }
    const a = ans.get(n)
    const q = {
      id: mkId(n), roc_year: year, session, exam_code: code, subject,
      subject_tag: sib?.subject_tag, subject_name: subject, paper_id: sib?.paper_id,
      stage_id: sib?.stage_id ?? 0, number: n,
      question: String(o.stem), options: { A: opts[0], B: opts[1], C: opts[2], D: opts[3] },
      answer: a && /^[ABCD]$/.test(String(a)) ? String(a) : 'A',
      explanation: '', exam_type: sib?.exam_type,
    }
    if (!(a && /^[ABCD]$/.test(String(a)))) { q.incomplete = true; q.incomplete_reason = '答案卷讀不到此題號' }
    for (const k of Object.keys(q)) if (q[k] === undefined) delete q[k]
    out.push(q)
  }

  console.log(`\n可補 ${out.length} 題${Object.keys(skip).length ? '｜跳過 ' + JSON.stringify(skip) : ''}`)
  for (const q of out.slice(0, 3)) {
    console.log(`  #${q.number} 答${q.answer}  ${String(q.question).replace(/\s+/g, ' ').slice(0, 54)}`)
    console.log(`     ${L.map(k => q.options[k].slice(0, 18)).join(' | ')}`)
  }
  console.log(`  id 樣式：${out[0]?.id} … ${out[out.length - 1]?.id}`)
  if (!APPLY) { console.log('\n（dry-run）'); return }
  arr.push(...out)
  if (j.total !== undefined) j.total = arr.length
  atomicWriteJson(fp, j)
  console.log('✅ 已寫回')
})().catch(e => { console.error(e.stack); process.exit(1) })
