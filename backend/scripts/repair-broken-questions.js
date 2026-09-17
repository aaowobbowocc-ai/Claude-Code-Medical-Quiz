#!/usr/bin/env node
/**
 * 拿考選部原卷重修「選項壞掉」的題。
 *
 * health-report.js 會掃出這幾種壞法，成因都是同一件事——PDF 解析時切錯：
 *   選項是頁首頁尾（"頁次:4-2" 變成選項 D）
 *   選項重複（A 和 D 一模一樣，其中一個是切錯的）
 *   選項中間有空洞、可選項不足兩個
 *   題幹空白且無圖
 *
 * 解析器這幾輪補強很多（幾何版型、PUA 選項標記、頁首過濾），所以很多題
 * 現在重解一次就對了。修不了的就標 incomplete 讓前端隱藏——
 * 使用者看到「選項 D：頁次:4-2」比看不到這題糟得多。
 *
 * 用法：
 *   node scripts/repair-broken-questions.js --exam customs
 *   node scripts/repair-broken-questions.js --all --apply
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve')
const { pdfQuestions } = require('./lib/moex-pdf-parse')
const { parseAnswerSheet } = require('./lib/moex-answer-sheet')
const { skeleton, normText } = require('./lib/moex-normalize')
const { warnZero, summary } = require('./lib/coverage-guard')

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d }
const EXAM = arg('--exam')
const ALL = process.argv.includes('--all')
const APPLY = process.argv.includes('--apply')
const RETRY = process.argv.includes('--retry')
// 題組解析失敗的題「題幹本身也是錯的」（整組被填成同一題），
// 所以不能用題幹比對來確認身分，只能信任題號、連題幹一起從原卷覆寫。
// 這比一般的 repair 激進，所以要獨立的旗標。
const REBUILD_CLOZE = process.argv.includes('--rebuild-cloze')
if (!EXAM && !ALL) { console.error('需要 --exam 或 --all'); process.exit(1) }

const DIR = path.join(__dirname, '..')
const HEADER = /^(代號|頁次|座號|等別|類科名稱|科目名稱|考試時間|考試名稱)\s*[：:]/

/** 這題壞在哪裡？回傳原因字串，沒壞回傳 null。 */
function diagnose(q) {
  // --retry：解析器補強之後，再拿上次修不了、標成 broken_options 的題試一次。
  // 這個標記是我們自己蓋的，不是「原始資料就這樣」，所以可以重來。
  if (q.incomplete === 'broken_options' && RETRY) { /* 往下重新診斷 */ }
  else if (q.incomplete === 'cloze_parse_failed' && REBUILD_CLOZE) return '題組解析失敗'
  else if (q.incomplete) return null
  const vals = ['A', 'B', 'C', 'D'].map(k => String((q.options || {})[k] ?? ''))
  const hasImg = !!(q.image_url || q.image || (q.images && q.images.length))
  if (vals.some(v => HEADER.test(v))) return '選項是頁首頁尾'
  const filled = vals.map(v => !!v.trim())
  const n = filled.filter(Boolean).length
  if (n < 2) return '可選項不足兩個'
  if (filled.slice(0, n).some(x => !x)) return '選項中間有空洞'
  // 選項是圖的題不要當成壞題：options 文字是「(圖)」，真正的內容在 option_images
  if (q.option_images && Object.keys(q.option_images).length >= 4) return null
  const ne = vals.filter(v => v.trim()).map(normText)
  if (new Set(ne).size < ne.length) return '選項重複'
  if (!String(q.question || '').trim() && !hasImg) return '題幹空白且無圖'
  return null
}

;(async () => {
  const files = ALL
    ? fs.readdirSync(DIR).filter(x => /^questions(-.*)?\.json$/.test(x) && !/\.bak/.test(x))
    : [EXAM === 'doctor1' ? 'questions.json' : `questions-${EXAM}.json`]

  let repaired = 0, marked = 0, unresolved = 0
  for (const f of files) {
    const exam = f === 'questions.json' ? 'doctor1' : f.replace('questions-', '').replace('.json', '')
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))
    const arr = Array.isArray(raw) ? raw : raw.questions
    if (!arr) continue
    const broken = arr.map(q => ({ q, why: diagnose(q) })).filter(x => x.why)
    if (!broken.length) continue

    // 依卷分組，一卷只抓一次 PDF
    const byPaper = new Map()
    for (const b of broken) {
      const k = `${b.q.exam_code}|${b.q.subject}`
      if (!byPaper.has(k)) byPaper.set(k, [])
      byPaper.get(k).push(b)
    }
    let touched = 0

    for (const [k, list] of byPaper) {
      const [code, subject] = k.split('|')
      if (!code || code === 'undefined') { unresolved += list.length; continue }
      const items = arr.filter(q => String(q.exam_code) === code && q.subject === subject)
      let off = null, official = {}
      try {
        const cand = await resolvePaper({ exam, code, year: items[0]?.roc_year, subject, items })
        if (cand) {
          const b = await fetchSheet('Q', code, cand.c, cand.s)
          if (b) off = await pdfQuestions(b)
          // 題組重建會連題幹一起換掉，答案當然也要跟著換——
          // 舊答案是照「錯的題目」存的，留著會變成「正確的題目配錯誤的答案」，
          // 比原本整組重複還糟。
          try { const sb = await fetchSheet('S', code, cand.c, cand.s); if (sb) official = await parseAnswerSheet(sb) } catch {}
        }
      } catch {}

      for (const { q, why } of list) {
        let src = off && off.get(+q.number)

        // ⚠️ 題組重建必須在「選項定位 fallback」之前處理。
        // 那段 fallback 是拿我們的選項去原卷找同一題——但題組解析失敗的題
        // 連選項都是壞的（整組被填成同一題的選項），比對只會一律指回那一題，
        // 於是整組的題幹全被覆寫成同一個。這個坑踩過一次，別再把它移到下面。
        if (why === '題組解析失敗') {
          const opts0 = src ? { A: src.options[0], B: src.options[1], C: src.options[2], D: src.options[3] } : null
          const clean0 = opts0 && ['A', 'B', 'C', 'D'].every(x => opts0[x] && opts0[x].trim() && !HEADER.test(opts0[x])) &&
            new Set(['A', 'B', 'C', 'D'].map(x => normText(opts0[x]))).size === 4
          const okStem = src && String(src.stem).trim().length >= 10
          const ans = official[+q.number]
          const okAns = ans && /^[A-D]$/.test(String(ans).trim())
          if (okStem && clean0 && okAns) {
            console.log(`  ✔ ${exam} ${code} ${subject} #${q.number} (${why}) → 題幹、選項、答案都從原卷重建`)
            if (APPLY) {
              q.question = String(src.stem).replace(/^[\s.．、]+/, '')
              q.options = opts0
              q.answer = String(ans).trim()
              q.explanation = ''
              delete q.incomplete
            }
            repaired++; touched++
          } else {
            console.log(`  ✖ ${exam} ${code} ${subject} #${q.number} (${why}) → 原卷讀不出來${okStem && clean0 && !okAns ? '（題目有、答案卷缺）' : ''}`)
            marked++
          }
          continue
        }
        // 一定要先確認是同一題再覆寫：題號對得上不代表內容對得上
        const key = skeleton(q.question || '').slice(0, 16)
        let same = !!(src && key && skeleton(src.stem).includes(key))
        // 題幹對不上時改用選項定位。詞彙同義字題的題幹只有一個單字
        //（"undermines"），根本不夠比；而且我們的題號常與原卷不同步。
        // 選項是逐題獨立的文字，對到兩個以上就幾乎不可能是別題。
        if (!same && off) {
          const ours = ['A', 'B', 'C', 'D'].map(x => normText(String((q.options || {})[x] ?? ''))).filter(Boolean)
          for (const [, o] of off) {
            const th = o.options.map(normText)
            if (ours.filter(x => th.includes(x)).length >= 2) { src = o; same = true; break }
          }
        }
        const opts = src ? { A: src.options[0], B: src.options[1], C: src.options[2], D: src.options[3] } : null
        const clean = opts && ['A', 'B', 'C', 'D'].every(x => opts[x] && opts[x].trim() && !HEADER.test(opts[x])) &&
          new Set(['A', 'B', 'C', 'D'].map(x => normText(opts[x]))).size === 4
        if (same && clean) {
          console.log(`  ✔ ${exam} ${code} ${subject} #${q.number} (${why}) → 已從原卷重解`)
          if (APPLY) { q.options = opts; if (q.incomplete === 'broken_options') delete q.incomplete }
          repaired++; touched++
        } else {
          console.log(`  ✖ ${exam} ${code} ${subject} #${q.number} (${why}) → 原卷也修不了，標 incomplete`)
          if (APPLY) q.incomplete = 'broken_options'
          marked++; touched++
        }
      }
    }
    if (APPLY && touched) {
      if (raw.metadata) raw.metadata.last_updated = new Date().toISOString()
      fs.writeFileSync(path.join(DIR, f), JSON.stringify(raw, null, 2) + '\n')
    }
  }

  console.log(`\n從原卷修好 ${repaired} 題，修不了改標 incomplete ${marked} 題，反查不到卷 ${unresolved} 題${APPLY ? '（已寫入）' : '（dry-run）'}`)
  warnZero('壞選項重修', repaired + marked, 'health-report 掃不到壞題，或 diagnose 條件沒涵蓋到')
  process.exitCode = summary()
})()
