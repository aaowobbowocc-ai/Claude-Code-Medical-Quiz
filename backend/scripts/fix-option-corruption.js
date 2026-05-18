#!/usr/bin/env node
// 批次修復選項損壞（scan-option-corruption.js 偵測到的題目）。
// 從快取 PDF 重新解析該題的 4 個選項，覆蓋損壞的舊選項。
//
// 安全機制：
//   - 以題號 + 題幹前 12 字（正規化）比對，確保抓到同一題
//   - 重抽結果必須「乾淨」（4 選項皆非空、無兩兩相同、無首字被吃）才套用
//   - 重抽後未損壞的選項需與 DB 多數吻合，否則跳過
//
// 用法: node scripts/fix-option-corruption.js [--exam medlab] [--apply]
const fs = require('fs')
const path = require('path')
const pdfParse = require('pdf-parse')
const { parseQuestions } = require('./lib/pdf-question-parser')
const { parseColumnAware } = require('./lib/moex-column-parser')

const BACKEND = path.join(__dirname, '..')
const CACHE_DIRS = ['_tmp/pdf-cache', '_tmp/pdf-cache-100-105']
const APPLY = process.argv.includes('--apply')
const examArg = process.argv.includes('--exam') ? process.argv[process.argv.indexOf('--exam') + 1] : null
const MIN_LEN = 12
const norm = s => String(s || '').replace(/[^一-鿿A-Za-z0-9]/g, '')

function buildIndex() {
  const idx = {}
  for (const dir of CACHE_DIRS) {
    const full = path.join(BACKEND, dir)
    if (!fs.existsSync(full)) continue
    for (const f of fs.readdirSync(full)) {
      if (!/\.pdf$/.test(f)) continue
      if (/^(S_|A_|M_|TS_|TA_|TM_)/.test(f)) continue   // 答案/更正 PDF 排除
      const m = f.match(/(\d{5,6})_c/)
      if (!m) continue
      ;(idx[m[1]] = idx[m[1]] || []).push(path.join(full, f))
    }
  }
  return idx
}

const pcache = {}
async function getParsed(file) {
  if (pcache[file] !== undefined) return pcache[file]
  try {
    const buf = fs.readFileSync(file)
    const text = (await pdfParse(buf)).text.normalize('NFKC')
    let qs = parseQuestions(text, { maxQNum: 200 })
    if (qs.length < 10) {
      try { const col = await parseColumnAware(buf); if (col.length > qs.length) qs = col } catch {}
    }
    pcache[file] = qs
  } catch { pcache[file] = [] }
  return pcache[file]
}

// 判斷某題選項是否損壞（與 scan-option-corruption.js 同邏輯）
function corruptKeys(o) {
  const keys = ['A', 'B', 'C', 'D']
  const bad = new Set()
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++)
    if (x !== y && o[x].length >= MIN_LEN && o[y].length === o[x].length + 1 && o[y].slice(1) === o[x]) bad.add(keys[x])
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++)
    if (o[i] && o[i].length >= MIN_LEN && o[i] === o[j]) { bad.add(keys[i]); bad.add(keys[j]) }
  return bad
}
const isClean = o => corruptKeys(o).size === 0 && o.every(v => v && v.length >= 1)

async function main() {
  const idx = buildIndex()
  let files = fs.readdirSync(BACKEND).filter(f => /^questions(-[\w-]+)?\.json$/.test(f))
  if (examArg) files = files.filter(f => f === `questions-${examArg}.json`)
  let total = 0, fixed = 0, noPdf = 0, noMatch = 0, dirty = 0
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(BACKEND, file), 'utf-8'))
    const arr = data.questions || data
    let fileFixed = 0
    for (const q of arr) {
      if (!q.options) continue
      const keys = ['A', 'B', 'C', 'D']
      const o = keys.map(k => String(q.options[k] ?? '').trim())
      const bad = corruptKeys(o)
      if (bad.size === 0) continue
      total++
      const pdfs = idx[String(q.exam_code)]
      if (!pdfs) { noPdf++; continue }
      let match = null
      for (const pf of pdfs) {
        const qs = await getParsed(pf)
        const pq = qs.find(x => Number(x.number) === Number(q.number) &&
          norm(x.question).slice(0, 12) === norm(q.question).slice(0, 12))
        if (pq && pq.options) { match = pq; break }
      }
      if (!match) { noMatch++; continue }
      const no = keys.map(k => String(match.options[k] ?? '').trim())
      if (!isClean(no)) { dirty++; continue }   // 重抽結果仍損壞 → 不套用
      // 健全性：未損壞的舊選項要跟重抽結果多數吻合
      let ok = 0, chk = 0
      for (let i = 0; i < 4; i++) if (!bad.has(keys[i]) && o[i]) { chk++; if (norm(no[i]) === norm(o[i])) ok++ }
      if (chk > 0 && ok / chk < 0.5) { noMatch++; continue }
      if (APPLY) for (const k of keys) q.options[k] = match.options[k]
      fixed++; fileFixed++
      if (fileFixed <= 4) console.log(`  ${file} id ${q.id} #${q.number}: ${[...bad].join(',')} 修正`)
    }
    if (fileFixed && APPLY) fs.writeFileSync(path.join(BACKEND, file), JSON.stringify(data, null, 2) + '\n')
    if (fileFixed) console.log(`${file}: ${fileFixed} 修正`)
  }
  console.log(`\n總計損壞 ${total} | 可修 ${fixed} | 無PDF ${noPdf} | 對不到題/選項不符 ${noMatch} | 重抽仍損壞 ${dirty}`)
  console.log(APPLY ? '(已套用)' : '(dry-run，加 --apply 寫入)')
}
main().catch(e => { console.error(e); process.exit(1) })
