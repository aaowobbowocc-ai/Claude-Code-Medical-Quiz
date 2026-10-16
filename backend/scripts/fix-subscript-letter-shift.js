#!/usr/bin/env node
/**
 * 修「中文語境裡的下標數字被推到字串尾巴」。
 *
 *   缺乏維生素B會引起腳氣病及巨紅血球性貧血1   → 缺乏維生素B1會引起…
 *   下列何者拮抗多巴胺D受體之作用最明顯…？2     → 多巴胺D2受體
 *   為組織胺H受體拮抗劑2                      → 組織胺H2受體
 *   某傳染性疾病的R為3，…何者正確？0           → R0為3
 *   處於G期的細胞受照射後…（anaphase bridge）1 → G1期
 *
 * 使用者回報：「115年第二次的題目與選項中多參雜無意義的數字」。
 *
 * 與 fix-subscript-shift.js 的分工：那支處理血液氣體符號白名單
 * （PaO2/SaO2/HCO3/cmH2O…），這支處理「中文詞 + 單一大寫字母」的下標。
 *
 * ⚠️ **不能用寬鬆簽章**。「中文夾孤立大寫字母 ＋ 尾端有數字」全站命中 39 處，
 * 其中 20 處是正常的：「相關係數高於0.9」「小明的T分數是40」「持股5%之股東2人」
 * 「表現BCL-6」「②Co-60 ③高能X光束 ④Ir-192」。所以改用白名單，
 * 每條規則都指明「插在哪個字後面」。
 *
 *   node scripts/fix-subscript-letter-shift.js            # dry-run
 *   node scripts/fix-subscript-letter-shift.js --apply
 */
const fs = require('fs')
const path = require('path')
const { atomicWriteJson } = require('./lib/atomic-write')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')

/**
 * 每條規則：anchor 比對到的那一段後面要插進尾端的數字。
 * anchor 一定要鎖住前後文，不能只認字母。
 */
const RULES = [
  { name: '維生素B', re: /(維生素|維他命)B(?![0-9A-Za-z])/ },
  { name: '多巴胺D受體', re: /多巴胺D(?=受體|接受器)/ },
  { name: '組織胺H受體', re: /組織胺H(?=受體|接受器)/ },
  { name: '基本再生數R', re: /的R(?=為)/ },
  { name: 'B磁場', re: /(?<![A-Za-z0-9])B(?=磁場)/ },
  { name: 'G期', re: /(?<![A-Za-z0-9])G(?=期)/ },
]

/**
 * 尾端被推出來的下標：可能不只一個。
 * 「G期和G期1 2」是兩個（空白分隔），「維生素B12」是一個（沒有空白）。
 */
function tailDigits(s) {
  const m = s.match(/((?:\s*\b\d{1,2}\b)+)\s*$/)
  if (!m) return null
  const toks = m[1].trim().split(/\s+/).filter(Boolean)
  return { toks, body: s.slice(0, s.length - m[0].length) }
}

/** 氣體符號：還沒有下標的 O / CO。 */
const GAS_RE = /(?<![A-Za-z0-9])(?:CO|O)(?![A-Za-z0-9])/g

function fixOne(text) {
  const s = String(text)
  const t = tailDigits(s)
  if (!t || !t.body) return null
  const { toks, body } = t

  /** 依序把 toks 插進 body 裡 re 的每一個命中點後面；命中數必須等於 toks 數。 */
  const place = (re, name) => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
    const hits = []
    let m
    while ((m = g.exec(body)) !== null) {
      hits.push(m.index + m[0].length)
      if (m.index === g.lastIndex) g.lastIndex++
    }
    if (hits.length !== toks.length) return null
    // 已經有下標的命中點不算（「又稱維生素B12」不是損壞）
    if (hits.some(at => /^\d/.test(body.slice(at)))) return null
    let out = '', prev = 0
    hits.forEach((at, i) => { out += body.slice(prev, at) + toks[i]; prev = at })
    out += body.slice(prev)
    return out === s ? null : { out, rule: toks.length > 1 ? `${name} ×${toks.length}` : name }
  }

  for (const r of RULES) {
    const got = place(r.re, r.name)
    if (got) return got
  }
  // 氣體符號只在「多個下標、而且全部一樣」時才動，避免把正常的單一 O 當成 O2
  if (toks.length > 1 && new Set(toks).size === 1) {
    const got = place(GAS_RE, '氣體符號')
    if (got) return got
  }
  return null
}

;(async () => {
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f))
  let fixed = 0
  const byRule = {}
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'))
    const arr = j.questions || j
    if (!Array.isArray(arr)) continue
    const exam = f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '')
    let touched = false
    for (const q of arr) {
      for (const field of ['question', 'A', 'B', 'C', 'D']) {
        const val = field === 'question' ? q.question : q.options?.[field]
        if (val == null) continue
        const r = fixOne(val)
        if (!r) continue
        // 「又稱維生素B12」拆開再組回去還是一樣——那不是損壞，別報成修好
        if (r.out === String(val)) continue
        byRule[r.rule] = (byRule[r.rule] || 0) + 1
        console.log(`${exam} ${q.exam_code} #${q.number} [${field}] (${r.rule})`)
        console.log(`  舊: ${String(val).replace(/\s+/g, ' ').slice(0, 64)}`)
        console.log(`  新: ${r.out.replace(/\s+/g, ' ').slice(0, 64)}`)
        if (APPLY) {
          if (field === 'question') q.question = r.out
          else q.options[field] = r.out
        }
        fixed++
        touched = true
      }
    }
    if (touched && APPLY) atomicWriteJson(path.join(BK, f), j)
  }
  console.log(`\n修 ${fixed} 處${APPLY ? '' : '（dry-run）'}`)
  console.log('依規則：' + JSON.stringify(byRule))
  if (APPLY && fixed) console.log('✅ 已寫回')
})().catch(e => { console.error(e.stack); process.exit(1) })
