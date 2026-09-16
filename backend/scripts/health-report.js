#!/usr/bin/env node
/**
 * 題庫健康總覽：一次掃出所有「使用者會看到的壞資料」。
 *
 * 分成兩類，處理優先序不同：
 *   A. 已被擋住的 —— 標了 incomplete，前端不會顯示。是待辦，不是傷害。
 *   B. 還看得到的 —— 沒有任何標記，使用者現在就會遇到。這才是要優先處理的。
 *
 * 用法：node scripts/health-report.js
 */
const fs = require('fs')
const path = require('path')
const { skeleton, normText } = require('./lib/moex-normalize')
const { IMAGE_REF } = require('./lib/image-ref')

const DIR = path.join(__dirname, '..')
const PUA = /[-]/
const HEADER = /^(代號|頁次|座號|等別|類科名稱|科目名稱|考試時間|考試名稱)\s*[：:]/

const files = fs.readdirSync(DIR).filter(f => /^questions(-.*)?\.json$/.test(f) && !/\.bak/.test(f))
const tally = { total: 0, incomplete: {}, visible: {} }
const detail = {}

const bump = (bucket, key, exam) => {
  tally[bucket][key] = (tally[bucket][key] || 0) + 1
  const d = (detail[key] = detail[key] || {})
  d[exam] = (d[exam] || 0) + 1
}

for (const f of files) {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))
  const arr = Array.isArray(raw) ? raw : raw.questions
  if (!arr) continue
  const exam = f === 'questions.json' ? 'doctor1' : f.replace('questions-', '').replace('.json', '')
  const dupKeys = new Map()

  for (const q of arr) {
    tally.total++
    if (q.incomplete) { bump('incomplete', String(q.incomplete), exam); continue }

    const opts = q.options || {}
    const vals = ['A', 'B', 'C', 'D'].map(k => String(opts[k] ?? ''))
    const stem = String(q.question ?? '')

    // 標誌辨識題的題幹本來就是空的——題目就是那張標誌圖，選項是它的含義。
    // 駕照 127+100 題都是這種，把它們算成壞題會讓數字虛胖。有圖就不算。
    const hasImg = !!(q.image_url || q.image || (q.images && q.images.length))
    if (!stem.trim()) { if (!hasImg) bump('visible', '題幹空白且無圖', exam) }
    // 題幹短不一定壞：「汽車油箱加油時：」就是完整的題目。
    // 真正壞的是短到不成句、選項也撐不住語意的（例如只剩 "lasted"）。
    else if (skeleton(stem).length < 5 && !hasImg) bump('visible', '題幹殘缺(<5字)', exam)
    // 選項數量不是一律 4 個：駕照是非題只有 ○/✕ 兩個、部分選擇題只有三個。
    // 一律要求 ABCD 齊全會把 2,405 題正常的駕照題算成壞題。
    // 真正的壞是「可選的選項少於兩個」或「中間有洞」（A、C 有但 B 空）。
    const filled = vals.map(v => !!v.trim())
    const nOpt = filled.filter(Boolean).length
    if (nOpt < 2) bump('visible', '可選項不足兩個', exam)
    else if (filled.slice(0, nOpt).some(x => !x)) bump('visible', '選項中間有空洞', exam)
    if (vals.some(v => HEADER.test(v))) bump('visible', '選項是頁首頁尾', exam)
    if (PUA.test(stem) || vals.some(v => PUA.test(v))) bump('visible', 'PUA 豆腐字', exam)
    // 複選題的答案是 "A,B,C"，那是正常資料（律師一試、部分公職考）。
    const ansRaw = String(q.answer ?? '').trim()
    const ansOk = /^[A-E](\s*[,、]\s*[A-E])*$/.test(ansRaw) || /^[○✕]/.test(ansRaw)
    if (!ansOk && !q.disputed) bump('visible', '答案格式無法辨識', exam)
    // 比選項是否重複不能用 skeleton：它會連減號一起去掉，
    // 放射師的「10 -4 / 10 -2 / 10 2 / 10 4」（10⁻⁴、10⁻²、10²、10⁴）
    // 會全部變成 "104"，460 題裡絕大多數是這樣誤判出來的。
    // 這裡只做 NFC＋去空白，保留所有符號。
    // 選項是圖的題（中藥材辨識、血球圖、化學結構式），options 文字就是
    // 「(圖)(圖)(圖)(圖)」，前端靠 option_images 顯示。那不是重複，是正常資料。
    const optImg = q.option_images && Object.keys(q.option_images).length >= 4
    const nonEmpty = optImg ? [] : vals.filter(v => v.trim()).map(v => normText(v))
    if (nonEmpty.length >= 2 && new Set(nonEmpty).size < nonEmpty.length) bump('visible', '選項重複', exam)
    if (IMAGE_REF.test(stem) && !q.images && !q.image && !q.no_image_in_source) bump('visible', '提到圖但沒有圖', exam)

    const k = `${q.exam_code}|${q.subject}||${skeleton(stem)}||${vals.map(skeleton).join('|')}`
    if (skeleton(stem).length >= 8) {
      if (dupKeys.has(k)) bump('visible', '同卷內完全重複', exam)
      else dupKeys.set(k, 1)
    }
  }
}

const show = (title, obj) => {
  const rows = Object.entries(obj).sort((a, b) => b[1] - a[1])
  const sum = rows.reduce((s, r) => s + r[1], 0)
  console.log(`\n${title}（共 ${sum} 題）`)
  for (const [k, n] of rows) {
    const by = Object.entries(detail[k] || {}).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([e, c]) => `${e} ${c}`).join('、')
    console.log(`  ${String(n).padStart(5)}  ${k.padEnd(24)} ${by}`)
  }
}

console.log(`全站 ${tally.total.toLocaleString()} 題`)
show('■ 使用者現在看得到的問題', tally.visible)
show('□ 已標 incomplete（前端隱藏，屬待辦）', tally.incomplete)
