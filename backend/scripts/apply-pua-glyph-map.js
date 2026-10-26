#!/usr/bin/env node
/**
 * 把 PUA 豆腐字換回真字，依據 data/pua-glyph-map.json。
 *
 * 考選部 PDF 的字型子集缺 ToUnicode 對應時，字會掉進 Unicode 私用區，
 * 在網頁上渲染成空白方框。對照表每一筆都附 why（判定依據），
 * 沒有依據的留在 unresolved 不動 —— 猜錯比留著豆腐字更糟，
 * 因為豆腐字看得見、猜錯看不見（[[feedback_verify_against_moex]]）。
 *
 * ⚠️ 一個碼位不一定只對一個字。字型可能把多個 glyph 映到同一格：
 *    U+EA86 在醫師一階 101030 醫學(二) #29 同時是「脲」和「苷」。
 *    這種走 overrides 逐處整句替換，不進 map。
 *
 * 配套：decipher-pua-from-corpus.js 用題庫語料**提案**（不自動套用），
 * 跑完把它報告裡 ✓ 的項目人工核對後才寫進對照表。
 *
 *   node scripts/apply-pua-glyph-map.js            # dry-run
 *   node scripts/apply-pua-glyph-map.js --apply
 */
const fs = require('fs')
const path = require('path')
const { atomicWriteJson } = require('./lib/atomic-write')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')
const L = ['A', 'B', 'C', 'D']
const EXAM = f => f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '')

const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'pua-glyph-map.json'), 'utf8'))
const MAP = new Map(Object.entries(spec.map).map(([hex, v]) => [parseInt(hex, 16), v.char]))
const FIELDS = q => [['question', q.question], ['explanation', q.explanation],
  ...L.map(k => [`options.${k}`, q.options?.[k]])]
const get = (q, f) => { const [g, k] = f.split('.'); return k ? q.options?.[k] : q[g] }
const set = (q, f, v) => { const [g, k] = f.split('.'); if (k) q.options[k] = v; else q[g] = v }

let cMap = 0, cOv = 0, left = new Map()
const touched = new Set()
const banks = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f))
  .map(f => { const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')); return { f, j, arr: j.questions || j } })

// ── overrides 先做（整句替換，免得被 map 先改掉而對不上）────────────
for (const ov of spec.overrides || []) {
  const b = banks.find(b => EXAM(b.f) === ov.exam)
  if (!b) { console.log(`✗ override 找不到考試 ${ov.exam}`); continue }
  const q = b.arr.find(q => String(q.exam_code) === String(ov.exam_code) &&
    q.subject === ov.subject && +q.number === ov.number)
  if (!q) { console.log(`✗ override 找不到 ${ov.exam} ${ov.exam_code} ${ov.subject} #${ov.number}`); continue }
  if (String(get(q, ov.field)) !== ov.from) {
    console.log(`✗ override ${ov.exam} ${ov.exam_code} #${ov.number} 現值與 from 不符，跳過`)
    continue
  }
  console.log(`override ${ov.exam} ${ov.exam_code} ${ov.subject} #${ov.number} [${ov.field}]`)
  console.log(`   → ${ov.to.slice(0, 80)}`)
  if (APPLY) set(q, ov.field, ov.to)
  cOv++; touched.add(b)
}

// ── map 逐字替換 ───────────────────────────────────────────────────
for (const b of banks) {
  for (const q of b.arr) {
    for (const [field] of FIELDS(q)) {
      const s = String(get(q, field) || '')
      if (!s || !/[-]/.test(s)) continue
      let out = '', n = 0
      for (const ch of s) {
        const cp = ch.codePointAt(0)
        if (cp >= 0xE000 && cp <= 0xF8FF) {
          // ⚠️ 用 has() 不要用真假值 —— Symbol 字型的多行括號分段字元
          //    （⎡⎢⎣⎤⎥⎦⎛⎜⎝⎞⎟⎠）與箭頭延長線在攤平的文字裡是雜訊，
          //    對照表給的是空字串「刪掉」，而空字串是 falsy。
          if (MAP.has(cp)) { out += MAP.get(cp); n++; continue }
          const hex = 'U+' + cp.toString(16).toUpperCase()
          if (!left.has(hex)) left.set(hex, { n: 0, ex: '' })
          const e = left.get(hex); e.n++
          if (!e.ex) { const i = s.indexOf(ch); e.ex = `${EXAM(b.f)} ${q.exam_code} #${q.number}：${s.slice(Math.max(0, i - 8), i)}【?】${s.slice(i + 1, i + 9)}` }
        }
        out += ch
      }
      if (!n) continue
      console.log(`${EXAM(b.f)} ${q.exam_code} #${q.number} [${field}] 換 ${n} 字`)
      console.log(`   ${out.replace(/\s+/g, ' ').slice(0, 96)}`)
      if (APPLY) set(q, field, out)
      cMap += n; touched.add(b)
    }
  }
}

console.log(`\n對照表換 ${cMap} 字｜override ${cOv} 處｜涵蓋 ${touched.size} 個題庫檔`)
if (left.size) {
  console.log('\n還沒解的碼位（留著，不猜）：')
  for (const [hex, e] of [...left].sort((a, b) => b[1].n - a[1].n))
    console.log(`  ${hex} ×${e.n}  ${e.ex}`)
}
if (APPLY) {
  for (const b of touched) atomicWriteJson(path.join(BK, b.f), b.j)
  console.log('✅ 已寫回')
} else console.log('（dry-run）')
