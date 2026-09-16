#!/usr/bin/env node
/**
 * 清掉題庫裡的 PUA 造字（前端顯示成豆腐字 □）。
 *
 * 考選部 PDF 用造字區塞兩種東西，處理方式完全不同：
 *
 *   A. 選項標記 U+E18C~U+E18F ＝ ⒶⒷⒸⒹ。純粹是視覺標記，我們的選項本來
 *      就存在 options.A~D 裡，直接刪掉不會損失任何資訊。
 *   B. 數學／符號字型 U+F0xx。那是 Symbol 字型的碼位，承載真正的語意
 *      （×、≥、→…）。**刪掉會讓題目變得看不懂**，所以只做已經查證過的
 *      對照轉換，沒把握的一律不動，留給人工處理。
 *
 * 用法：
 *   node scripts/fix-pua-chars.js            # dry-run
 *   node scripts/fix-pua-chars.js --apply
 */
const fs = require('fs')
const path = require('path')
const { warnZero, summary } = require('./lib/coverage-guard')

const APPLY = process.argv.includes('--apply')
const DIR = path.join(__dirname, '..')

// 純視覺標記，刪掉即可
const MARKS = /[-]/g
// Symbol 字型對照（只列查證過的；F0xx 其餘碼位不動）
const SYMBOL = {
  '': '×', '': '÷', '': '±', '': '≥', '': '≤',
  '': '×', '': '→', '': '→', '': '←',
  '': '≤', '': '≠', '': 'α', '': 'β', '': 'γ',
  '': 'δ', '': 'λ', '': 'μ', '': 'π', '': 'σ',
  '': 'ω', '': 'Ω', '': 'Δ',
}
const SYMBOL_RE = new RegExp('[' + Object.keys(SYMBOL).join('') + ']', 'g')
const ANY_PUA = /[-]/

let marksFixed = 0, symbolsFixed = 0
const leftover = {}

for (const f of fs.readdirSync(DIR).filter(x => /^questions(-.*)?\.json$/.test(x) && !/\.bak/.test(x))) {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))
  const arr = Array.isArray(raw) ? raw : raw.questions
  if (!arr) continue
  const exam = f === 'questions.json' ? 'doctor1' : f.replace('questions-', '').replace('.json', '')
  let touched = 0

  const clean = (t) => {
    if (typeof t !== 'string' || !ANY_PUA.test(t)) return t
    let out = t
    const m = out.match(MARKS)
    if (m) { marksFixed += m.length; out = out.replace(MARKS, '') }
    const sy = out.match(SYMBOL_RE)
    if (sy) { symbolsFixed += sy.length; out = out.replace(SYMBOL_RE, c => SYMBOL[c]) }
    return out.replace(/\s{2,}/g, ' ').trim()
  }

  for (const q of arr) {
    const before = JSON.stringify([q.question, q.options])
    const nq = clean(q.question)
    const nopts = {}
    for (const k of Object.keys(q.options || {})) nopts[k] = clean(q.options[k])
    if (JSON.stringify([nq, nopts]) !== before) {
      if (APPLY) { q.question = nq; q.options = nopts }
      touched++
    }
    // 清完還有殘留的，記下來給人看——那些是沒把握的符號，不該亂刪
    const rest = String(nq) + Object.values(nopts).join('')
    if (ANY_PUA.test(rest)) {
      for (const c of rest.match(/[-]/g) || []) {
        const k = 'U+' + c.codePointAt(0).toString(16).toUpperCase()
        leftover[k] = leftover[k] || { n: 0, exams: new Set() }
        leftover[k].n++
        leftover[k].exams.add(exam)
      }
    }
  }
  if (APPLY && touched) {
    if (raw.metadata) raw.metadata.last_updated = new Date().toISOString()
    fs.writeFileSync(path.join(DIR, f), JSON.stringify(raw, null, 2) + '\n')
    console.log(`  ${f}: ${touched} 題`)
  }
}

console.log(`\n刪除選項標記 ${marksFixed} 個、還原符號 ${symbolsFixed} 個${APPLY ? '（已寫入）' : '（dry-run）'}`)
const rows = Object.entries(leftover).sort((a, b) => b[1].n - a[1].n)
if (rows.length) {
  console.log(`\n仍有 ${rows.reduce((s, r) => s + r[1].n, 0)} 個未處理的 PUA —— 這些沒查證過對應字元，不要亂刪：`)
  for (const [k, v] of rows.slice(0, 15)) console.log(`  ${k.padEnd(8)} ${String(v.n).padStart(4)} 次  ${[...v.exams].join('、')}`)
}
warnZero('PUA 清理', marksFixed + symbolsFixed, '題庫裡已經沒有已知的 PUA 造字')
process.exitCode = summary()
