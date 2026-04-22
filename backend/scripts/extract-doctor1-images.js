#!/usr/bin/env node
// Run extract-images-v3 across all doctor1 papers, then link the extracted
// image URLs back into questions.json via image_url field.

const fs = require('fs')
const path = require('path')
const { extractSession } = require('./extract-images-v3')

const QFILE = path.join(__dirname, '..', 'questions.json')

// doctor1 paper URL mapping per year×session. Each entry is one year×session
// (2 papers: 醫學一 + 醫學二).
const SESSIONS = [
  // 030 series (100-104): c=101, s=0101/0102
  { yr:'100', ses:'第一次', code:'100030', papers:[{c:'101',s:'0101'},{c:'101',s:'0102'}] },
  { yr:'100', ses:'第二次', code:'100140', papers:[{c:'101',s:'0101'},{c:'101',s:'0102'}] },
  { yr:'101', ses:'第一次', code:'101030', papers:[{c:'101',s:'0101'},{c:'101',s:'0102'}] },
  { yr:'101', ses:'第二次', code:'101110', papers:[{c:'101',s:'0101'},{c:'101',s:'0102'}] },
  { yr:'102', ses:'第一次', code:'102030', papers:[{c:'101',s:'0101'},{c:'101',s:'0102'}] },
  { yr:'102', ses:'第二次', code:'102110', papers:[{c:'101',s:'0101'},{c:'101',s:'0102'}] },
  { yr:'103', ses:'第一次', code:'103030', papers:[{c:'101',s:'0101'},{c:'101',s:'0102'}] },
  { yr:'103', ses:'第二次', code:'103100', papers:[{c:'101',s:'0101'},{c:'101',s:'0102'}] },
  { yr:'104', ses:'第一次', code:'104030', papers:[{c:'101',s:'0101'},{c:'101',s:'0102'}] },
  { yr:'104', ses:'第二次', code:'104090', papers:[{c:'301',s:'55'},  {c:'301',s:'66'}] },
  // 020 series (105+): c=301
  { yr:'105', ses:'第一次', code:'105020', papers:[{c:'301',s:'55'},  {c:'301',s:'66'}] },
  { yr:'105', ses:'第二次', code:'105100', papers:[{c:'301',s:'55'},  {c:'301',s:'66'}] },
  { yr:'106', ses:'第一次', code:'106020', papers:[{c:'301',s:'55'},  {c:'301',s:'66'}] },
  { yr:'106', ses:'第二次', code:'106100', papers:[{c:'301',s:'11'},  {c:'301',s:'22'}] },
  { yr:'107', ses:'第一次', code:'107020', papers:[{c:'301',s:'11'},  {c:'301',s:'22'}] },
  { yr:'107', ses:'第二次', code:'107100', papers:[{c:'301',s:'11'},  {c:'301',s:'22'}] },
  { yr:'108', ses:'第一次', code:'108030', papers:[{c:'301',s:'11'},  {c:'301',s:'22'}] },
  { yr:'108', ses:'第二次', code:'108100', papers:[{c:'301',s:'11'},  {c:'301',s:'22'}] },
  { yr:'109', ses:'第一次', code:'109020', papers:[{c:'301',s:'11'},  {c:'301',s:'22'}] },
  { yr:'109', ses:'第二次', code:'109100', papers:[{c:'301',s:'11'},  {c:'301',s:'22'}] },
  { yr:'110', ses:'第一次', code:'110020', papers:[{c:'301',s:'11'},  {c:'301',s:'22'}] },
  { yr:'110', ses:'第二次', code:'110101', papers:[{c:'301',s:'11'},  {c:'301',s:'22'}] },
  { yr:'111', ses:'第一次', code:'111020', papers:[{c:'301',s:'11'},  {c:'301',s:'22'}] },
  { yr:'111', ses:'第二次', code:'111100', papers:[{c:'301',s:'11'},  {c:'301',s:'22'}] },
  { yr:'112', ses:'第一次', code:'112020', papers:[{c:'301',s:'11'},  {c:'301',s:'22'}] },
  { yr:'112', ses:'第二次', code:'112100', papers:[{c:'301',s:'11'},  {c:'301',s:'22'}] },
  { yr:'113', ses:'第一次', code:'113020', papers:[{c:'301',s:'11'},  {c:'301',s:'22'}] },
  { yr:'113', ses:'第二次', code:'113090', papers:[{c:'301',s:'11'},  {c:'301',s:'22'}] },
  // 114-115 年 subject code 改回 4 位數（114 年起 s=0101/0102 而非 11/22）
  { yr:'114', ses:'第一次', code:'114020', papers:[{c:'301',s:'0101'},{c:'301',s:'0102'}] },
  { yr:'114', ses:'第二次', code:'114090', papers:[{c:'301',s:'0101'},{c:'301',s:'0102'}] },
  { yr:'115', ses:'第一次', code:'115020', papers:[{c:'301',s:'0101'},{c:'301',s:'0102'}] },
]

const SUBJ_BY_PAPER = ['醫學(一)', '醫學(二)']

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const onlyYear = args.find(a => a.startsWith('--year='))
  const yearFilter = onlyYear ? onlyYear.split('=')[1] : null

  const data = JSON.parse(fs.readFileSync(QFILE, 'utf8'))
  const arr = Array.isArray(data) ? data : data.questions

  // Index stored questions by (yr, session, subject, number) for fast linking
  const idx = new Map()
  for (const q of arr) {
    idx.set(`${q.roc_year}|${q.session}|${q.subject}|${q.number}`, q)
  }

  let totalImages = 0
  let totalLinked = 0

  for (const sess of SESSIONS) {
    if (yearFilter && sess.yr !== yearFilter) continue
    console.log(`\n=== ${sess.yr}-${sess.ses} (${sess.code}) ===`)
    let result
    try {
      result = await extractSession({ exam: 'doctor1', code: sess.code, papers: sess.papers }, { dryRun })
    } catch (e) {
      console.log('  session error:', e.message)
      continue
    }
    for (const [pi, mapping] of Object.entries(result)) {
      const subj = SUBJ_BY_PAPER[+pi]
      for (const [numStr, urls] of Object.entries(mapping)) {
        const num = +numStr
        const key = `${sess.yr}|${sess.ses}|${subj}|${num}`
        const q = idx.get(key)
        if (!q) continue
        q.image_url = urls[0]
        if (urls.length > 1) q.images = urls
        totalImages += urls.length
        totalLinked++
      }
    }
  }

  console.log(`\n=== Linked ${totalLinked} questions with ${totalImages} images ===`)

  if (dryRun) { console.log('(dry-run, no write)'); return }
  if (totalLinked === 0) return
  const tmp = QFILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, QFILE)
  console.log('wrote', QFILE)
}

main().catch(e => { console.error(e); process.exit(1) })
