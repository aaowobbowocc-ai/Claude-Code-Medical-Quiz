#!/usr/bin/env node
/**
 * 全站「外來題」稽核：這一題，真的印在它自己那張卷上嗎？
 *
 * 為什麼既有工具抓不到：
 *   audit-paper-alignment.js 算的是整卷命中率，門檻是「<50% 才告警」。
 *   dental2 104090 卷一 有 3 題是醫師二階的題佔走的，但另外 77 題題號完全相符
 *   ——命中率 96%，體檢完全沒感覺。只要受污染的題數少，整卷統計就蓋得住。
 *
 * 所以這支不看整卷比率，逐題問一個是非題：**這題的題幹在原卷上找得到嗎**。
 * 找不到的就列出來，並在全站搜同樣的題幹，指出它可能是從哪個考試跑來的
 * （同場次代碼是最常見的成因：104090 同時是醫師與牙醫的場次代碼）。
 *
 * ⚠️ 這支**只讀不寫**，而且會有誤報：原卷解析不乾淨、題組題、含圖題被轉寫過，
 * 都可能讓題幹對不上。輸出是「要人看一眼的清單」，不是「要改的清單」。
 * 修要走 repair-cross-exam-overwrite.js，它另外要求「找得到覆蓋來源」才動。
 *
 *   node scripts/audit-foreign-questions.js                 # 全站
 *   node scripts/audit-foreign-questions.js --exam=dental2
 *   node scripts/audit-foreign-questions.js --max=8         # 每卷超過 N 題就當整卷壞掉，另案處理
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve')
const { pdfStems } = require('./lib/moex-pdf-parse')
const { skeleton } = require('./lib/moex-normalize')

const BK = path.join(__dirname, '..')
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1]
const MAX = +((process.argv.find(a => a.startsWith('--max=')) || '').split('=')[1]) || 8

// 不是考選部來源，resolvePaper 對不到
const SKIP = new Set(['gsat', 'ast', 'driver-car', 'driver-moto', 'post-indoor', 'post-outdoor',
  'railway-admin', 'railway-transport', 'state-finance', 'state-hr', 'state-it', 'state-mgmt',
  'teacher-elementary', 'teacher-kindergarten', 'teacher-secondary', 'teacher-special', 'teacher-special-gifted'])
const EXAM = f => f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '')

// ⚠️ 比對長度門檻不能低。第一版用 20 字前綴、最短 12 字，結果牙科題被配到
// 「ast 112 物理 #8」——短題幹（「兒童白血病好發於幾歲?」）的整串會意外包含在
// 別的長題幹裡。兩邊都要夠長，重疊段也要夠長，才算同一題。
const MIN = 24
const near = (a, b) => {
  const x = skeleton(String(a)), y = skeleton(String(b))
  if (!x || !y || x.length < MIN || y.length < MIN) return false
  return x.includes(y.slice(0, MIN)) || y.includes(x.slice(0, MIN))
}
/** 題幹太短就不判——比不動，硬比只會製造誤報。 */
const tooShort = t => skeleton(String(t)).length < MIN

;(async () => {
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f))

  // 全站題幹索引，用來回答「這題從哪來」
  const index = []
  for (const f of files) {
    const arr = (j => j.questions || j)(JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')))
    if (!Array.isArray(arr)) continue
    for (const q of arr) index.push({ exam: EXAM(f), code: String(q.exam_code), subject: q.subject, n: q.number, k: skeleton(String(q.question)) })
  }
  console.log(`全站題幹索引 ${index.length} 題\n`)

  const report = []
  let papers = 0, unresolved = 0, wholePaper = 0
  for (const f of files) {
    const exam = EXAM(f)
    if (SKIP.has(exam) || (only && exam !== only)) continue
    const arr = (j => j.questions || j)(JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')))
    if (!Array.isArray(arr)) continue

    const groups = new Map()
    for (const q of arr) {
      if (!q.exam_code || !q.subject) continue
      const k = q.exam_code + '\u0000' + q.subject
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(q)
    }
    for (const [k, items] of groups) {
      const [code, subject] = k.split('\u0000')
      let stems = null
      try {
        const p = await resolvePaper({ exam, code: String(code), subject, year: String(items[0].roc_year), items })
        if (!p) throw new Error('no paper')
        stems = await pdfStems(await fetchSheet('Q', String(code), p.c, p.s))
      } catch { unresolved++; continue }
      if (!stems || stems.size < items.length * 0.5) { unresolved++; continue }
      papers++
      const all = [...stems.values()]
      const foreign = items.filter(q => !tooShort(q.question) && !all.some(s => near(q.question, s)))
      if (!foreign.length) continue
      if (foreign.length > MAX) {
        wholePaper++
        console.log(`⚠️ ${exam} ${code} ${subject.slice(0, 18)}：${foreign.length}/${items.length} 題對不上，整卷有問題，另案處理`)
        continue
      }
      for (const q of foreign) {
        const from = index.filter(r => (r.exam !== exam || r.code !== String(code) || r.subject !== subject) && near(q.question, r.k))
        const rec = { exam, code, subject, n: q.number, stem: String(q.question).replace(/\s+/g, ' ').slice(0, 56),
          sameCodeDonor: from.filter(r => r.code === String(code) && +r.n === +q.number).map(r => `${r.exam} ${r.subject} #${r.n}`),
          anyDonor: from.slice(0, 3).map(r => `${r.exam} ${r.code} ${r.subject} #${r.n}`) }
        report.push(rec)
        // 只印強簽章。其餘（原卷解析不乾淨、題組、含圖題被轉寫）誤報率高，
        // 留在 JSON 裡備查，不佔畫面。
        if (rec.sameCodeDonor.length) {
          console.log(`${exam} ${code} ${subject.slice(0, 16)} #${q.number}  ${rec.stem}  ← ${rec.sameCodeDonor[0]}（同場次同題號）`)
        }
      }
    }
  }

  const dest = path.join(BK, '_tmp', 'foreign-questions.json')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, JSON.stringify(report, null, 1))
  const strong = report.filter(r => r.sameCodeDonor.length).length
  console.log(`\n掃過 ${papers} 卷（${unresolved} 卷對不到或解析不足，${wholePaper} 卷整卷有問題）`)
  console.log(`題幹在自己卷上找不到：${report.length} 題，其中 ${strong} 題在別的考試的同場次同題號找得到（跨考試覆蓋的典型簽章）`)
  console.log(`📄 ${dest}`)
})().catch(e => { console.error(e.stack); process.exit(1) })
