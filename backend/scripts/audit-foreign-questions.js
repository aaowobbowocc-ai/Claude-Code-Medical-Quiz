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
const { resolvePaper, fetchSheet, pdfText } = require('./lib/moex-paper-resolve')
const { skeleton } = require('./lib/moex-normalize')
const { pdfTextClean } = require('./lib/moex-run-overlap')

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

// 「這題在這張卷上嗎」：**用整卷原始文字，不要用 pdfStems**。
// pdfStems 會逐題切塊，公式與表格密集的題一切就壞（藥師一階卷三實測：
// 題幹頭被吃掉、表格內容蓋掉問句），於是好題被誤判成外來題。
// 2026-10-11 就是這樣把 pharma1 的 6 題好內容覆寫成更爛的解析，已回退。
//
// 多點取樣：題幹的開頭、1/4、中段各取 20 字，任一命中就算存在。
// 刻意偏向「判定為非外來」——漏抓一題外來題，遠比毀掉一題好題便宜。
const PROBE = 20
// paperText 傳陣列：原始文字 + 消除 run 重疊後的文字，**任一命中就算在卷上**。
// 有些卷的每一列是好幾個互相重疊一個字的 run，直接串會變成
// 「一位266 歲服役中的的男性」，整卷題幹都對不上（醫師二階 103030 醫學(四)
// 命中率 78%，消重疊後 93%）。但抽樣 46 卷只有這兩卷受益、還有一卷變差，
// 所以不改共用的 pdfText，只在這裡當備援。見 lib/moex-run-overlap.js。
function inPaper(stem, texts) {
  const k = skeleton(String(stem))
  const list = [].concat(texts).filter(Boolean)
  if (k.length < PROBE || !list.length) return true        // 比不動就當它在，不要亂動
  const at = [0, Math.floor(k.length / 4), Math.floor(k.length / 2)]
  return list.some(T => at.some(i => i + PROBE <= k.length && T.includes(k.slice(i, i + PROBE))))
}


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
      let text = null
      try {
        const p = await resolvePaper({ exam, code: String(code), subject, year: String(items[0].roc_year), items })
        if (!p) throw new Error('no paper')
        const buf = await fetchSheet('Q', String(code), p.c, p.s)
        text = [skeleton(await pdfText(buf)), skeleton(await pdfTextClean(buf))]
      } catch { unresolved++; continue }
      if (!text || !text[0] || text[0].length < 200) { unresolved++; continue }
      const judged = items.filter(q => !tooShort(q.question))
      const foreign = judged.filter(q => !inPaper(q.question, text))
      // 自我檢查：這張卷如果連 60% 都對不上，多半是對到錯的卷或文字層壞掉，
      // 整卷不判，免得把一整卷好題列成外來題。
      if (judged.length && (judged.length - foreign.length) / judged.length < 0.6) { unresolved++; continue }
      papers++
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

  // ⚠️ 全站一口氣跑會壞：mupdf 的 document handle 不會釋放，跑到 600 多卷之後
  // pdfStems 開始整批失敗（2,537/3,175 卷「解析不足」），最後在 fz_drop_page 崩掉。
  // 要全站請用 run-foreign-audit.sh，每個考試開一個 process。
  const dest = path.join(BK, '_tmp', only ? `foreign-questions-${only}.json` : 'foreign-questions.json')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, JSON.stringify(report, null, 1))
  const strong = report.filter(r => r.sameCodeDonor.length).length
  console.log(`\n掃過 ${papers} 卷（${unresolved} 卷對不到或解析不足，${wholePaper} 卷整卷有問題）`)
  console.log(`題幹在自己卷上找不到：${report.length} 題，其中 ${strong} 題在別的考試的同場次同題號找得到（跨考試覆蓋的典型簽章）`)
  console.log(`📄 ${dest}`)
})().catch(e => { console.error(e.stack); process.exit(1) })
