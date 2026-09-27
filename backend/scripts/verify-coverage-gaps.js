#!/usr/bin/env node
/**
 * 拿 coverage-report 報的缺口，逐卷向考選部查證「本科目共N題」。
 *
 * coverage-report 的預期題數是用**鄰居年份**推的，考試改制時會整場誤報：
 * 護理師 112 第三次本來就是 50 題／科，夾在兩個 80 題的場次中間，
 * 於是被當成四卷各缺 30 題（120 題）——實際上一題都不缺。
 * 官方試題 PDF 第一頁一定寫「本科目共N題」，拿那個當預期值才準。
 *
 *   node scripts/coverage-report.js --json      # 先產生缺口清單
 *   node scripts/verify-coverage-gaps.js        # 再逐卷查證
 *   node scripts/verify-coverage-gaps.js --exam nursing
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { resolvePaper } = require('./lib/moex-paper-resolve')
const { fetchSheet } = require('./lib/moex-paper-resolve')
const { pdfText } = require('./lib/moex-pdf-parse')

const ROOT = path.join(__dirname, '..')
const GAPS = path.join(ROOT, '_tmp', 'coverage-gaps.json')
const arg = k => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null }
const ONLY = arg('--exam')

// 這些考試不是考選部辦的，沒有可查的官方試題 PDF
const NON_MOEX = /^(gsat|ast|driver-|post-|state-|railway-|teacher-)/

function loadQuestions(exam) {
  const file = exam === 'doctor1' ? 'questions.json' : `questions-${exam}.json`
  const p = path.join(ROOT, file)
  if (!fs.existsSync(p)) return []
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  return j.questions || j
}

/** 從試題 PDF 第一頁讀「本科目共N題」。讀不到回 null。 */
function declaredCount(text) {
  const t = text.replace(/\s+/g, ' ').slice(0, 800)
  const m = /本科目共\s*([0-9０-９]{1,3})\s*題/.exec(t)
  if (!m) return null
  return Number(m[1].replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)))
}

;(async () => {
  if (!fs.existsSync(GAPS)) {
    console.error('找不到 _tmp/coverage-gaps.json，先跑 node scripts/coverage-report.js --json')
    process.exit(1)
  }
  const rows = JSON.parse(fs.readFileSync(GAPS, 'utf8'))
    .filter(r => !NON_MOEX.test(r.exam))
    .filter(r => !ONLY || r.exam === ONLY)
  console.log(`要查證 ${rows.length} 卷\n`)

  const cache = {}
  const real = [], bogus = [], unknown = []
  for (const r of rows) {
    const qs = cache[r.exam] || (cache[r.exam] = loadQuestions(r.exam))
    const same = qs.filter(q => String(q.roc_year) === String(r.year) && q.session === r.session)
    const code = same.length ? String(same[0].exam_code) : null
    if (!code) { unknown.push({ ...r, why: '找不到場次代碼' }); continue }
    const items = same.filter(q => q.subject === r.paper)
    let paper = null
    try {
      paper = await resolvePaper({ exam: r.exam, code, subject: r.paper, year: String(r.year), items })
    } catch {}
    if (!paper) { unknown.push({ ...r, code, why: '對不到官方卷' }); continue }
    let decl = null
    try {
      const buf = await fetchSheet('Q', code, paper.c, paper.s)
      if (buf) decl = declaredCount(await pdfText(buf))
    } catch {}
    if (decl == null) { unknown.push({ ...r, code, why: '卷上沒寫「本科目共N題」' }); continue }
    const short = decl - r.have
    const tag = `${r.exam} ${r.year} ${r.session} ${r.paper}`
    if (short > 0) {
      real.push({ ...r, code, c: paper.c, s: paper.s, declared: decl, short })
      console.log(`  ⚠ ${tag}：我們 ${r.have}／官方 ${decl} → 真的缺 ${short}`)
    } else {
      bogus.push({ ...r, code, declared: decl })
      console.log(`  ✓ ${tag}：我們 ${r.have}／官方 ${decl} → 沒缺（預期值 ${r.expect} 是鄰居年份推錯的）`)
    }
  }

  const sum = real.reduce((a, b) => a + b.short, 0)
  console.log(`\n真缺 ${real.length} 卷 / ${sum} 題；誤報 ${bogus.length} 卷；查不到 ${unknown.length} 卷`)
  const out = path.join(ROOT, '_tmp', 'coverage-gaps-verified.json')
  fs.writeFileSync(out, JSON.stringify({ real, bogus, unknown }, null, 2))
  console.log(`📄 ${out}`)
  if (unknown.length) {
    const why = {}
    unknown.forEach(u => { why[u.why] = (why[u.why] || 0) + 1 })
    console.log('查不到的原因：', JSON.stringify(why))
  }
})().catch(e => { console.error(e.stack); process.exit(1) })
