#!/usr/bin/env node
/**
 * 把對話讀圖還原的選項寫回題庫（配合 export-broken-for-vision.js）。
 *
 * 讀 _tmp/vision-broken/manifest.json 與同目錄的 answers.json，
 * 依 manifest 的 id 對應把 options 覆寫回去，並清掉 broken_options 標記。
 *
 * 防呆：
 *   - answers.json 裡的 id 必須在 manifest 裡（避免貼錯檔案寫到別題）
 *   - 四個選項都要有內容、不得重複、不得殘留 PUA
 *
 * 用法：node scripts/apply-vision-options.js [--apply]
 */
const fs = require('fs')
const path = require('path')
const { normText } = require('./lib/moex-normalize')
const { warnZero, summary } = require('./lib/coverage-guard')

const APPLY = process.argv.includes('--apply')
const DIR = path.join(__dirname, '..')
const VDIR = path.join(DIR, '_tmp', 'vision-broken')
const manifest = JSON.parse(fs.readFileSync(path.join(VDIR, 'manifest.json'), 'utf8'))
const answers = JSON.parse(fs.readFileSync(path.join(VDIR, 'answers.json'), 'utf8'))

const byId = new Map(manifest.map(m => [m.id, m]))
const byFile = {}
let ok = 0, bad = 0

for (const [id, opts] of Object.entries(answers)) {
  const m = byId.get(id)
  if (!m) { console.log(`  ✖ ${id}: 不在 manifest 裡，跳過`); bad++; continue }
  const vals = ['A', 'B', 'C', 'D'].map(k => String(opts[k] ?? '').trim())
  if (vals.some(v => !v)) { console.log(`  ✖ ${id}: 選項有空的`); bad++; continue }
  if (new Set(vals.map(normText)).size !== 4) { console.log(`  ✖ ${id}: 選項有重複`); bad++; continue }
  if (vals.some(v => /[-]/.test(v))) { console.log(`  ✖ ${id}: 選項含 PUA`); bad++; continue }
  const f = m.exam === 'doctor1' ? 'questions.json' : `questions-${m.exam}.json`
  ;(byFile[f] = byFile[f] || []).push({ m, opts: { A: vals[0], B: vals[1], C: vals[2], D: vals[3] } })
  ok++
}

for (const [f, list] of Object.entries(byFile)) {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))
  const arr = Array.isArray(raw) ? raw : raw.questions
  const idx = new Map(arr.map(q => [String(q.id), q]))
  for (const { m, opts } of list) {
    const q = idx.get(m.id)
    if (!q) { console.log(`  ✖ ${m.id}: 題庫裡找不到`); continue }
    console.log(`  ✔ ${m.exam} ${m.code} ${m.subject} #${m.number}`)
    if (APPLY) { q.options = opts; delete q.incomplete }
  }
  if (APPLY) {
    if (raw.metadata) raw.metadata.last_updated = new Date().toISOString()
    fs.writeFileSync(path.join(DIR, f), JSON.stringify(raw, null, 2) + '\n')
  }
}

console.log(`\n還原 ${ok} 題，退回 ${bad} 題${APPLY ? '（已寫入）' : '（dry-run）'}`)
warnZero('讀圖還原', ok, 'answers.json 是空的，或 id 都對不上 manifest')
process.exitCode = summary()
