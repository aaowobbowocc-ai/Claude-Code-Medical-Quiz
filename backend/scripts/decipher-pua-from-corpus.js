#!/usr/bin/env node
/**
 * 用題庫自己當語料，把 PUA 豆腐字解回真正的漢字。
 *
 *   「乳酸脫氫<U+E2C6>（LD）」  → 別的考試有「乳酸脫氫酶（LD）」   → E2C6 = 酶
 *   「足背伸肌和伸<U+EEE7>肌」  → 別題有「足背伸肌和伸趾肌」       → EEE7 = 趾
 *   「胸<U+E2F7>苦滿之病機」    → 別題有「胸脅苦滿之病機」         → E2F7 = 脅
 *
 * 與 decipher-glyph-map.js 的差別：那支處理「字型硬猜成別的字」
 * （甀→瘀），用 bigram 似然；這支處理「字型沒有 Unicode 對應、
 * 直接掉進私用區」，用**語料精確比對**，不猜。
 *
 * 做法：取 PUA 前後各 N 字當上下文，在全站題庫找
 * `前文 + 任一字 + 後文`，蒐集候選字。只有**唯一候選**才採信。
 * 上下文從長到短放寬（6→5→4→3），先中的先算。
 *
 * ⚠️ 不處理 U+F0xx（Symbol 字型的數學運算子，上下文是公式，語料比對無效）
 *    與 U+E000~E00F／U+E12x（選項與注意事項的項目符號，不是漢字）。
 *    那兩群各自另案處理。
 *
 *   node scripts/decipher-pua-from-corpus.js            # 只報告
 *   node scripts/decipher-pua-from-corpus.js --apply
 */
const fs = require('fs')
const path = require('path')
const { atomicWriteJson } = require('./lib/atomic-write')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const L = ['A', 'B', 'C', 'D']
const MAXCTX = 6
const MINCTX = 3

const PUA = /[-]/
/** 不是漢字的 PUA：Symbol 字型的數學符號、項目符號。 */
const notHan = k => (k >= 0xF000 && k <= 0xF0FF) || (k >= 0xE000 && k <= 0xE01F) ||
  (k >= 0xE120 && k <= 0xE13F) || (k >= 0xE180 && k <= 0xE19F)

const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f))
const banks = files.map(f => ({ f, j: JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')) }))
for (const b of banks) b.arr = b.j.questions || b.j

/** 全站乾淨語料：每一段文字一列，含 PUA 的段落不收（免得拿垃圾比垃圾）。 */
const corpus = []
for (const b of banks) {
  for (const q of b.arr) {
    for (const t of [q.question, ...L.map(k => q.options?.[k]), q.explanation]) {
      const s = String(t || '')
      if (s && !PUA.test(s)) corpus.push(s.replace(/\s+/g, ''))
    }
  }
}
const CORPUS = corpus.join('\u0001')
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 在語料裡找 `before + ? + after`，回傳候選字集合。 */
function candidates(before, after) {
  if (!before && !after) return new Set()
  const re = new RegExp(esc(before) + '([\\u4E00-\\u9FFF])' + esc(after), 'g')
  const out = new Set()
  let m, guard = 0
  while ((m = re.exec(CORPUS)) !== null && guard++ < 5000) out.add(m[1])
  return out
}

// ── 蒐集所有 PUA 出現位置 ──────────────────────────────────────────
const hits = []   // {bank, q, field, idx, cp, before, after}
for (const b of banks) {
  for (const q of b.arr) {
    const fields = [['question', q.question], ['explanation', q.explanation],
      ...L.map(k => [`options.${k}`, q.options?.[k]])]
    for (const [field, raw] of fields) {
      const s = String(raw || '')
      for (let i = 0; i < s.length; i++) {
        const k = s.codePointAt(i)
        if (k < 0xE000 || k > 0xF8FF) continue
        hits.push({ bank: b, q, field, idx: i, cp: k,
          before: s.slice(Math.max(0, i - MAXCTX), i).replace(/\s+/g, ''),
          after: s.slice(i + 1, i + 1 + MAXCTX).replace(/\s+/g, '') })
      }
    }
  }
}

// ── 逐個碼位投票：同一碼位的所有出現都該解成同一個字 ────────────────
const byCp = new Map()
for (const h of hits) {
  if (!byCp.has(h.cp)) byCp.set(h.cp, [])
  byCp.get(h.cp).push(h)
}

const solved = new Map()   // cp -> char
const report = []
for (const [cp, hs] of [...byCp].sort((a, b) => b[1].length - a[1].length)) {
  const hex = 'U+' + cp.toString(16).toUpperCase()
  if (notHan(cp)) { report.push(`－ ${hex} ×${hs.length}  非漢字（符號／項目符號），另案`); continue }
  const votes = new Map()
  for (const h of hs) {
    for (let n = MAXCTX; n >= MINCTX; n--) {
      const cand = candidates(h.before.slice(-n), h.after.slice(0, n))
      if (cand.size === 1) { const c = [...cand][0]; votes.set(c, (votes.get(c) || 0) + 1); break }
      if (cand.size > 1 && cand.size <= 4 && n === MINCTX) {
        for (const c of cand) votes.set(c, (votes.get(c) || 0) + 0.01)
      }
    }
  }
  const top = [...votes].sort((a, b) => b[1] - a[1])
  if (!top.length) { report.push(`? ${hex} ×${hs.length}  語料查不到：${hs[0].before}【?】${hs[0].after}`); continue }
  if (top.length > 1 && top[0][1] === top[1][1]) {
    report.push(`? ${hex} ×${hs.length}  候選平手 ${top.slice(0, 4).map(x => x[0]).join('/')}：${hs[0].before}【?】${hs[0].after}`)
    continue
  }
  if (top[0][1] < 1) { report.push(`? ${hex} ×${hs.length}  只有弱證據 ${top.map(x => x[0]).join('/')}：${hs[0].before}【?】${hs[0].after}`); continue }
  solved.set(cp, top[0][0])
  report.push(`✓ ${hex} ×${hs.length}  → 「${top[0][0]}」（${top[0][1]} 票${top.length > 1 ? '，次選 ' + top[1][0] : ''}）  ${hs[0].before}【${top[0][0]}】${hs[0].after}`)
}

console.log(report.join('\n'))
console.log(`\n解出 ${solved.size} / ${[...byCp].filter(([k]) => !notHan(k)).length} 個漢字碼位`)

// ── 套用 ───────────────────────────────────────────────────────────
let changed = 0
const touched = new Set()
for (const h of hits) {
  const c = solved.get(h.cp)
  if (!c) continue
  const [grp, key] = h.field.split('.')
  const obj = key ? h.q.options : h.q
  const k = key || grp
  const s = String(obj[k])
  if (s.codePointAt(h.idx) !== h.cp) continue       // 位置被前面的替換挪動過就跳過
  if (APPLY) obj[k] = s.slice(0, h.idx) + c + s.slice(h.idx + 1)
  changed++
  touched.add(h.bank)
}
console.log(`${APPLY ? '已替換' : '可替換'} ${changed} 處，涵蓋 ${touched.size} 個題庫檔`)
if (APPLY) {
  for (const b of touched) atomicWriteJson(path.join(BK, b.f), b.j)
  console.log('✅ 已寫回')
}
