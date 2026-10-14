#!/usr/bin/env node
/**
 * 修「每個字都重複一次」的題：
 *
 *   下下圖圖為為數數名名失失語語症症個個案案病病灶灶位位置置疊疊加加的的圖圖示示
 *   連合纖維路徑（ccoommmmiissssuurraall ffiibbeerr ttrraacctt）
 *
 * 成因與 lib/moex-run-overlap.js 處理的是同一件事：考選部有些 PDF 的每一列
 * 是好幾個**互相重疊**的 text run，當初建題庫時直接串接就把重疊的字寫進去了。
 * 稽核端已經修好（當備援），但題庫裡的舊資料還留著。
 *
 * **去重判準**：只收掉「連續 ≥2 組疊字」的區段。單獨一組不動——
 * 中文的「漸漸」「常常」「高高」是合法的，連著兩組以上才是版面造成的。
 *
 * **閘門是原卷**：去重後的題幹拿回原卷算 8 字滑動視窗覆蓋率，
 * **必須比去重前高**才寫入。這是自我驗證的——改對了覆蓋率會從 0~50% 跳到 ~100%，
 * 改錯了會掉下來。對不到原卷的卷一律不動。
 *
 *   node scripts/fix-doubled-chars.js            # dry-run
 *   node scripts/fix-doubled-chars.js --apply
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const fs = require('fs')
const path = require('path')
const { resolvePaper, fetchSheet, pdfText } = require('./lib/moex-paper-resolve')
const { pdfTextClean } = require('./lib/moex-run-overlap')
const { skeleton } = require('./lib/moex-normalize')
const { atomicWriteJson } = require('./lib/atomic-write')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1]
const RATE = 0.12          // 疊字率低於這個就不是這種損壞，別去動它
const N = 8                // 覆蓋率的滑動視窗
const EXAM = f => f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '')
const SKIP = new Set(['gsat', 'ast', 'driver-car', 'driver-moto', 'post-indoor', 'post-outdoor',
  'railway-admin', 'railway-transport', 'state-finance', 'state-hr', 'state-it', 'state-mgmt',
  'teacher-elementary', 'teacher-kindergarten', 'teacher-secondary', 'teacher-special', 'teacher-special-gifted'])

/** 相鄰字元相同的比例。正常中文 1~2%。 */
function dupRate(t) {
  const s = String(t).replace(/\s/g, '')
  if (s.length < 24) return 0
  let d = 0
  for (let i = 1; i < s.length; i++) if (s[i] === s[i - 1]) d++
  return d / s.length
}

/** 收掉「連續 ≥2 組疊字」的區段。 */
function dedouble(text) {
  const s = String(text), out = []
  let i = 0
  while (i < s.length) {
    let k = 0
    while (i + 2 * k + 1 < s.length && s[i + 2 * k] === s[i + 2 * k + 1]) k++
    if (k >= 2) { for (let j = 0; j < k; j++) out.push(s[i + 2 * j]); i += 2 * k }
    else { out.push(s[i]); i++ }
  }
  return out.join('')
}

function cover(t, texts) {
  const k = skeleton(String(t))
  if (k.length < N + 4) return null
  let hit = 0, tot = 0
  for (let i = 0; i + N <= k.length; i++) { tot++; if (texts.some(T => T.includes(k.slice(i, i + N)))) hit++ }
  return tot ? hit / tot : null
}

;(async () => {
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f))
  let fixed = 0, skipped = 0
  const skipWhy = {}
  const bump = r => { skipWhy[r] = (skipWhy[r] || 0) + 1; skipped++ }

  for (const f of files) {
    const exam = EXAM(f)
    if (SKIP.has(exam) || (only && exam !== only)) continue
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'))
    const arr = j.questions || j
    if (!Array.isArray(arr)) continue

    // 先找出有疊字的題，再依卷分組（避免為了沒問題的卷去抓 PDF）
    const dirty = arr.filter(q => dupRate(q.question) >= RATE
      || ['A', 'B', 'C', 'D'].some(k => dupRate(q.options?.[k]) >= RATE))
    if (!dirty.length) continue
    const byPaper = new Map()
    for (const q of dirty) {
      const k = q.exam_code + '\u0000' + q.subject
      if (!byPaper.has(k)) byPaper.set(k, [])
      byPaper.get(k).push(q)
    }

    let touched = false
    for (const [k, items] of byPaper) {
      const [code, subject] = k.split('\u0000')
      const all = arr.filter(q => String(q.exam_code) === String(code) && q.subject === subject)
      let texts
      try {
        const p = await resolvePaper({ exam, code: String(code), subject, year: String(all[0]?.roc_year), items: all })
        if (!p) throw new Error('對不到原卷')
        const buf = await fetchSheet('Q', String(code), p.c, p.s)
        texts = [skeleton(await pdfText(buf)), skeleton(await pdfTextClean(buf))]
      } catch { for (const _ of items) bump('對不到原卷，不敢動'); continue }
      if (!texts[0] || texts[0].length < 200) { for (const _ of items) bump('原卷文字層讀不出來'); continue }

      for (const q of items) {
        const fields = [['question', q.question], ...['A', 'B', 'C', 'D'].map(x => [x, q.options?.[x]])]
        const changes = []
        for (const [name, val] of fields) {
          if (val == null) continue
          if (dupRate(val) < RATE) continue
          const fix = dedouble(String(val))
          if (fix === String(val)) continue
          const a = cover(val, texts), b = cover(fix, texts)
          if (a === null || b === null) { bump('太短無法用原卷驗證'); continue }
          if (b <= a) { bump('去重後覆蓋率沒有變好'); continue }
          changes.push({ name, from: String(val), to: fix, a, b })
        }
        if (!changes.length) continue
        console.log(`\n${exam} ${code} ${subject.slice(0, 14)} #${q.number}`)
        for (const c of changes) {
          console.log(`  [${c.name}] 覆蓋 ${Math.round(c.a * 100)}% → ${Math.round(c.b * 100)}%`)
          console.log(`    舊: ${c.from.replace(/\s+/g, ' ').slice(0, 54)}`)
          console.log(`    新: ${c.to.replace(/\s+/g, ' ').slice(0, 54)}`)
          if (APPLY) {
            if (c.name === 'question') q.question = c.to
            else q.options[c.name] = c.to
          }
        }
        fixed++
        touched = true
      }
    }
    if (touched && APPLY) atomicWriteJson(path.join(BK, f), j)
  }

  console.log(`\n修好 ${fixed} 題｜跳過 ${skipped}${APPLY ? '' : '（dry-run）'}`)
  if (skipped) console.log('跳過原因：' + JSON.stringify(skipWhy))
  if (APPLY && fixed) console.log('✅ 已寫回')
})().catch(e => { console.error(e.stack); process.exit(1) })
