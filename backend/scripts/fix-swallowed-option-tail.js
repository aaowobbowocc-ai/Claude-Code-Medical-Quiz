#!/usr/bin/env node
/**
 * 切掉「最後一個選項吞掉後面整段文章」的尾巴。
 *
 *   D: "willWhen I was a kid, I did not like to play the piano…"   → "will"
 *   D: "tombs On March 23, 1999, the musical MAMMA MIA!…"           → "tombs"
 *   D: "①正確，②錯誤，③無法判斷 以前生活比較艱苦，小孩又多…"        → "①正確，②錯誤，③無法判斷"
 *
 * 與 repair-ceec-option-tail.js 的分工：那支只在**明確標記**處切
 * （「X-Y題為題組」「請記得在答題卷簽名」），切不到就留著。剩下這批沒有標記。
 *
 * 進場條件（客觀，不是猜內容）：某一個選項的長度 ≥ 同伴最長的 8 倍，而且 >300 字。
 * 正常的長選項（放射師 111020 #40 四個選項都 300~500 字）倍數只有 1x，不會進來。
 *
 * 切點兩條規則，都要求切掉的尾巴 >100 字：
 *   1. 小寫字母／右括號 後面接大寫字母——吞進來的文章開頭
 *      willWhen / horribleFanta / slowSam / 兩側面神經麻痺（facial paralysis）Acoustic
 *   2. 空白後面接長文——中文題組的引文
 *      「④理義之悅我心，猶芻豢之悅我口 現在流行區分E人、I人…」
 *
 * 再加兩道防呆：切完的頭要 ≤ 同伴最長的 3 倍（切太多或太少都不對），而且非空。
 * 兩條規則都切不到就整段留著——切壞好選項比少修還糟
 * （[[procedure_health_report_rules]]）。
 *
 *   node scripts/fix-swallowed-option-tail.js            # dry-run
 *   node scripts/fix-swallowed-option-tail.js --apply
 */
const fs = require('fs')
const path = require('path')
const { atomicWriteJson } = require('./lib/atomic-write')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const RATIO = 8        // 進場：比同伴長幾倍
const MIN_LEN = 300    // 進場：至少幾字
const TAIL_MIN = 100   // 切掉的尾巴至少幾字
const HEAD_MAX = 3     // 切完的頭最多是同伴最長的幾倍

/**
 * 切完的頭不能以英文虛詞結尾——那代表切在句子中間，不是選項的結尾。
 * 藥師 102020 #50 的「選項」整段其實是 AI 描述洩漏進來的，
 * 規則 1 會把它切成「The chemical structure of」，比不切還糟。
 */
const DANGLING = /(?:of|the|an?|in|on|at|for|to|and|or|with|by|from|as|is|are|was|were|that|which)$/i

/** 回傳切點（切完的頭），切不到回 null。 */
function cutPoint(text, maxSib) {
  const s = String(text)
  const limit = Math.max(16, Math.ceil(maxSib * HEAD_MAX))

  // 規則 1：小寫／右括號 後面接大寫字母
  const re1 = /[a-z)）]\s*(?=[A-Z])/g
  let m
  while ((m = re1.exec(s)) !== null) {
    const at = m.index + 1
    const head = s.slice(0, at).trim()
    if (!head || head.length > limit) break
    if (s.length - at < TAIL_MIN) continue
    if (DANGLING.test(head)) continue
    return head
  }

  // 規則 2：空白後面接長文
  const re2 = /\s+/g
  while ((m = re2.exec(s)) !== null) {
    const head = s.slice(0, m.index).trim()
    if (!head) continue
    if (head.length > limit) break
    if (s.length - m.index - m[0].length < TAIL_MIN) continue
    if (DANGLING.test(head)) continue
    return head
  }
  return null
}

;(async () => {
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f))
  let fixed = 0, skipped = 0
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'))
    const arr = j.questions || j
    if (!Array.isArray(arr)) continue
    const exam = f.replace(/questions-?|\.json/g, '') || 'doctor1'
    let touched = false
    for (const q of arr) {
      const ks = Object.keys(q.options || {})
      if (ks.length < 3) continue
      const lens = ks.map(k => String(q.options[k]).length)
      const mx = Math.max(...lens)
      if (mx < MIN_LEN) continue
      const kMax = ks[lens.indexOf(mx)]
      const sib = lens.filter((_, i) => ks[i] !== kMax)
      const maxSib = Math.max(...sib)
      if (!maxSib || mx / maxSib < RATIO) continue

      // 同伴是 AI 產生的佔位文字 → 整題的選項本來就是假的，不是吞尾巴。
      // 藥師 102020 #50 四個選項都是「[This would be an incorrect chemical structure…]」，
      // 切它只會留下「The chemical structure of」這種懸空片段。
      if (ks.some(k => /^\s*[\[［]|would be an? (?:in)?correct/i.test(String(q.options[k])))) {
        skipped++
        console.log(`⊘ ${exam} ${q.exam_code} #${q.number}：選項是 AI 佔位文字，整題另案處理`)
        continue
      }

      const head = cutPoint(q.options[kMax], maxSib)
      if (!head) {
        skipped++
        console.log(`⊘ ${exam} ${q.exam_code} #${q.number} [${kMax}] ${mx}字（同伴最長 ${maxSib}）切不到，留著`)
        console.log(`   ${String(q.options[kMax]).replace(/\s+/g, ' ').slice(0, 72)}`)
        continue
      }
      console.log(`${exam} ${q.exam_code} #${q.number} [${kMax}] ${mx} → ${head.length} 字（同伴最長 ${maxSib}）`)
      console.log(`   保留: ${JSON.stringify(head)}`)
      console.log(`   切掉: ${JSON.stringify(String(q.options[kMax]).slice(head.length, head.length + 56))}…\n`)
      if (APPLY) q.options[kMax] = head
      fixed++
      touched = true
    }
    if (touched && APPLY) atomicWriteJson(path.join(BK, f), j)
  }
  console.log(`切 ${fixed} 題｜切不到留著 ${skipped} 題${APPLY ? '' : '（dry-run）'}`)
  if (APPLY && fixed) console.log('✅ 已寫回')
})().catch(e => { console.error(e.stack); process.exit(1) })
