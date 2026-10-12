#!/usr/bin/env node
/**
 * 套用 decipher-glyph-map.js 解出來的「壞字 → 正確字」對照表。
 *
 * 這些字是 PDF 字型沒有合法 ToUnicode 對應、當初的抽取器硬猜出來的碼位
 * （猜得很一致，所以是 1:1 替換）。原卷在那些位置是 `�`，讀不回正確字，
 * 對照表是從 1,601 萬字的乾淨語料用 bigram 似然解出來的。
 *
 * **每一處都要通過 bigram 驗證才改**：替換後形成的 (prev,Y) 或 (Y,next)
 * 至少有一組在乾淨語料裡出現過。兩組都沒出現就不改，列出來人工看。
 * 這擋得住「同一個壞字在某些地方其實是別的字」的情況。
 *
 * ⚠️ 刻意不收兩個字：
 *   荊 —— 271 次是合法的（黃荊、牡荊是中藥，荊棘是成語）
 *   蛉 —— 「白蛉」是 sandfly（利什曼原蟲病媒）；但「劑蛉」是劑量。混用，要逐題判。
 *
 *   node scripts/apply-glyph-map.js            # dry-run，列出所有會改的地方
 *   node scripts/apply-glyph-map.js --apply
 */
const fs = require('fs')
const path = require('path')
const { atomicWriteJson } = require('./lib/atomic-write')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const CJK = /[一-鿿]/

/** decipher-glyph-map.js 的結果。margin 標在後面，1.2 以上才收。 */
const MAP = {
  '蜻': '列',  // 8.44
  '蠋': '療',  // 5.88
  '躏': '見',  // 4.85
  '觑': '狀',  // 4.73
  '败': '度',  // 3.46
  '蒠': '塞',  // 3.40
  '蹋': '降',  // 3.15
  '菘': '不',  // 2.57
  '装': '流',  // 2.53
  '褺': '理',  // 1.79
  '甀': '瘀',  // 1.37（margin 低是因為「瘀」本身罕用，例子全對：血甀→血瘀、瀉熱逐甀→瀉熱逐瘀）
  '蜕': '年',  // 1.26
  '葝': '數',  // 1.21（計葝器→計數器、激發次葝→激發次數）
}
// 第二批（2026-10-12）。出現次數少到可以逐一看過，全部查證無誤：
Object.assign(MAP, {
  '襬': '鱗',  // 襬狀細胞癌 / 子宮頸襬狀上皮癌 → 鱗狀
  '裩': '倫',  // 符合醫學裩理 → 醫學倫理
  '蜄': '力',  // 心智能蜄 / 肌蜄 / 氣道阻蜄 / 血流動蜄 / 重症肌無蜄
  '葲': '參',  // 基準葲考線 / 葲與國際衛生組織 / 標準葲考點
  '豣': '切',  // 豣片證實 / 適豣的點頭
})

/**
 * 混用的壞字只能做**詞組**取代，不能做字元取代：
 *   蟾 —— 「蟾蜍」是真的（盤古蟾蜍、蟾蜍二烯內酯），但「赇蟾病」是糖尿病
 *   赇 —— 「赇蟾病」「血赇」是糖，「多赇體」是醣（polysaccharide），兩個字不同
 * 詞組先套，剩下的單字再交給 MAP。
 */
const PHRASES = [
  ['赇蟾病', '糖尿病'],
  ['血赇', '血糖'],
  ['多赇體', '多醣體'],
]

const SUS = new Set(Object.keys(MAP))

;(async () => {
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f))

  // ── 乾淨語料的 bigram（不含任何壞字的句子）────────────────────────
  const fwd = new Map()
  const data = {}
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'))
    const arr = j.questions || j
    if (!Array.isArray(arr)) continue
    data[f] = j
    for (const q of arr) {
      for (const raw of [String(q.question || ''), ...['A', 'B', 'C', 'D'].map(k => String(q.options?.[k] || ''))]) {
        const s = raw.replace(/\s+/g, '')
        if ([...s].some(c => SUS.has(c))) continue
        for (let i = 0; i + 1 < s.length; i++) {
          const a = s[i], b = s[i + 1]
          if (!CJK.test(a) || !CJK.test(b)) continue
          if (!fwd.has(a)) fwd.set(a, new Set())
          fwd.get(a).add(b)
        }
      }
    }
  }
  const seen = (a, b) => fwd.get(a)?.has(b) || false

  /** 回傳 { out, changes:[{from,to,ctx,ok}] }。ok=false 的那一處不會被改。 */
  function fix(text) {
    let s = String(text)
    const phraseHits = []
    for (const [a, b] of PHRASES) {
      if (!s.includes(a)) continue
      phraseHits.push({ from: a, to: b, n: s.split(a).length - 1 })
      s = s.split(a).join(b)
    }
    if (!s || (![...s].some(c => SUS.has(c)) && !phraseHits.length)) return null
    const chars = [...s]
    const changes = []
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i]
      if (!SUS.has(c)) continue
      const Y = MAP[c]
      // 前後文取最近的 CJK（跳過空白與標點），用來驗 bigram
      let p = null, n = null
      for (let j = i - 1; j >= 0 && j >= i - 3; j--) { if (CJK.test(chars[j]) && !SUS.has(chars[j])) { p = chars[j]; break } }
      for (let j = i + 1; j < chars.length && j <= i + 3; j++) { if (CJK.test(chars[j]) && !SUS.has(chars[j])) { n = chars[j]; break } }
      const ok = (p && seen(p, Y)) || (n && seen(Y, n)) || (!p && !n)
      const ctx = chars.slice(Math.max(0, i - 6), i + 7).join('')
      changes.push({ from: c, to: Y, ctx, ok })
      if (ok) chars[i] = Y
    }
    for (const h of phraseHits) changes.push({ from: h.from, to: h.to, ctx: h.from + '→' + h.to, ok: true, n: h.n })
    return { out: chars.join(''), changes }
  }

  let nFix = 0, nSkip = 0
  const skipped = []
  const byChar = {}
  const samples = {}
  for (const [f, j] of Object.entries(data)) {
    const arr = j.questions || j
    let touched = false
    for (const q of arr) {
      for (const field of ['question', 'case_context']) {
        const r = fix(q[field])
        if (!r) continue
        for (const c of r.changes) {
          if (c.ok) { nFix++; byChar[c.from] = (byChar[c.from] || 0) + 1; (samples[c.from] ||= []).length < 3 && samples[c.from].push(c.ctx) }
          else { nSkip++; skipped.push({ f, n: q.number, ...c }) }
        }
        if (r.out !== String(q[field])) { if (APPLY) q[field] = r.out; touched = true }
      }
      for (const k of ['A', 'B', 'C', 'D']) {
        if (!q.options || q.options[k] == null) continue
        const r = fix(q.options[k])
        if (!r) continue
        for (const c of r.changes) {
          if (c.ok) { nFix++; byChar[c.from] = (byChar[c.from] || 0) + 1; (samples[c.from] ||= []).length < 3 && samples[c.from].push(c.ctx) }
          else { nSkip++; skipped.push({ f, n: q.number, ...c }) }
        }
        if (r.out !== String(q.options[k])) { if (APPLY) q.options[k] = r.out; touched = true }
      }
    }
    if (touched && APPLY) atomicWriteJson(path.join(BK, f), j)
  }

  console.log('逐字統計（通過 bigram 驗證、已換掉的）：')
  for (const [c, n] of Object.entries(byChar).sort((a, b) => b[1] - a[1])) {
    const to = MAP[c] || (PHRASES.find(p => p[0] === c) || [])[1] || '?'
    console.log(`  ${c} → ${to}   ${String(n).padStart(3)} 處   例：${(samples[c] || []).join('  ')}`)
  }
  console.log(`\n換掉 ${nFix} 處｜bigram 驗不過、保留原字 ${nSkip} 處${APPLY ? '' : '（dry-run）'}`)
  for (const s of skipped) console.log(`  ⊘ ${s.f.replace(/questions-?|\.json/g, '') || 'doctor1'} #${s.n}  ${s.from}→${s.to}  …${s.ctx}…`)
  if (APPLY) console.log('✅ 已寫回')
})().catch(e => { console.error(e.stack); process.exit(1) })
