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
const ALLOW_LANG = process.argv.includes('--allow-lang-mismatch')
const DIR = path.join(__dirname, '..')
const VDIR = path.join(DIR, '_tmp', 'vision-broken')
const manifest = JSON.parse(fs.readFileSync(path.join(VDIR, 'manifest.json'), 'utf8'))
const answers = JSON.parse(fs.readFileSync(path.join(VDIR, 'answers.json'), 'utf8'))

const byId = new Map(manifest.map(m => [m.id, m]))
const byFile = {}
let ok = 0, bad = 0

for (const [id, entry] of Object.entries(answers)) {
  const m = byId.get(id)
  if (!m) { console.log(`  ✖ ${id}: 不在 manifest 裡，跳過`); bad++; continue }
  // 題組解析失敗的題連題幹和答案都要換（舊答案是照錯的題目存的），
  // 所以 answers.json 可以多帶 question / answer 兩個欄位。
  const opts = entry.options || entry
  const stem = entry.question
  const ans = entry.answer
  if (ans !== undefined && !/^[A-D]$/.test(String(ans))) { console.log(`  ✖ ${id}: answer 不是 A-D`); bad++; continue }
  const vals = ['A', 'B', 'C', 'D'].map(k => String(opts[k] ?? '').trim())
  if (vals.some(v => !v)) { console.log(`  ✖ ${id}: 選項有空的`); bad++; continue }
  if (new Set(vals.map(normText)).size !== 4) { console.log(`  ✖ ${id}: 選項有重複`); bad++; continue }
  if (vals.some(v => /[-]/.test(v))) { console.log(`  ✖ ${id}: 選項含 PUA`); bad++; continue }
  // 題幹與選項的語言必須一致。關務 109050「英文」卷裡混著法學題
  //（題幹是中文法學題、選項卻是英文克漏字選項），從原卷讀到的是英文選項，
  //  寫回去就變成「法學題幹配英文選項」——看起來正常、實際上全錯，
  //  比原本被隱藏更危險。不一致就拒絕寫入，交給人判斷。
  const isCJK = (t) => /[一-鿿]/.test(String(t))
  const m2 = byId.get(id)
  const curStem = stem || (m2 && m2.currentQuestion)
  // ⚠️ 醫學類考試「中文題幹 + 英文術語選項」是完全正常的（Type II/III/IV/V、
  //    Weber test/Rinne test…），所以這道檢查一定會有誤擋。
  //    它擋的是關務那種「中文法學題幹 + 英文功能詞選項（once/unless/since）」——
  //    那是題幹與選項來自不同卷的錯配，寫進去會變成看起來正常、實際全錯的題。
  //    確認過是正常術語題時，用 --allow-lang-mismatch 放行。
  if (!ALLOW_LANG && curStem && isCJK(curStem) && !vals.some(isCJK)) {
    console.log(`  ✖ ${id}: 中文題幹配全英文選項，可能是跨卷錯配 —— 確認無誤請加 --allow-lang-mismatch`)
    console.log(`       題幹: ${String(curStem).slice(0, 40)}`)
    console.log(`       選項: ${vals.join(' / ').slice(0, 60)}`)
    bad++; continue
  }
  const f = m.exam === 'doctor1' ? 'questions.json' : `questions-${m.exam}.json`
  ;(byFile[f] = byFile[f] || []).push({ m, stem, ans, opts: { A: vals[0], B: vals[1], C: vals[2], D: vals[3] } })
  ok++
}

for (const [f, list] of Object.entries(byFile)) {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))
  const arr = Array.isArray(raw) ? raw : raw.questions
  const idx = new Map(arr.map(q => [String(q.id), q]))
  for (const { m, stem, ans, opts } of list) {
    const q = idx.get(m.id)
    if (!q) { console.log(`  ✖ ${m.id}: 題庫裡找不到`); continue }
    const extra = [stem ? '題幹' : null, ans ? '答案' : null].filter(Boolean).join('＋')
    console.log(`  ✔ ${m.exam} ${m.code} ${m.subject} #${m.number}${extra ? '（含' + extra + '）' : ''}`)
    if (APPLY) {
      q.options = opts
      if (stem) q.question = String(stem).trim()
      if (ans) { q.answer = String(ans); q.explanation = '' }
      delete q.incomplete
    }
  }
  if (APPLY) {
    if (raw.metadata) raw.metadata.last_updated = new Date().toISOString()
    fs.writeFileSync(path.join(DIR, f), JSON.stringify(raw, null, 2) + '\n')
  }
}

console.log(`\n還原 ${ok} 題，退回 ${bad} 題${APPLY ? '（已寫入）' : '（dry-run）'}`)
warnZero('讀圖還原', ok, 'answers.json 是空的，或 id 都對不上 manifest')
process.exitCode = summary()
