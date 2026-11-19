#!/usr/bin/env node
/**
 * 把每個 exam-config 的 totalQ + seo.totalQ 同步到實際 questions JSON 數量。
 * 同時更新 frontend snapshot。輸出全站合計題數，給 SEO 文案用。
 */
const fs = require('fs')
const path = require('path')
const { atomicWriteJson } = require('./lib/atomic-write')

const BACKEND = path.resolve(__dirname, '..')
const FRONTEND_SNAPSHOT = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'exam-configs-snapshot')
const CONFIG_DIR = path.join(BACKEND, 'exam-configs')

let siteTotal = 0
const siteYears = new Set()
const updates = []

for (const file of fs.readdirSync(CONFIG_DIR).filter(f => f.endsWith('.json'))) {
  const cfgPath = path.join(CONFIG_DIR, file)
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
  let actual
  const years = []
  if (cfg.questionsFile) {
    const qPath = path.join(BACKEND, cfg.questionsFile)
    if (!fs.existsSync(qPath)) continue
    const data = JSON.parse(fs.readFileSync(qPath, 'utf-8'))
    const rows = data.questions || data
    actual = rows.length
    years.push(...rows.map(q => Number(q.roc_year)))
    siteTotal += actual
  } else if ((cfg.sharedBanks || []).length) {
    // 公職／司法的 shell 考試沒有自己的題庫檔，題目全部來自共用題庫。
    // 這裡原本直接 continue，於是共用題庫補題之後那幾張卡的題數永遠停在舊值
    //（civil-senior-general 停在 2475、judicial 停在 908）。
    // 前端是依 level 篩共用題庫的，這裡用同一條件算。
    const level = { level_3_common: 'senior', level_4_common: 'junior', level_5_common: 'elementary' }[cfg.sharedScope]
    actual = 0
    for (const b of cfg.sharedBanks) {
      const p = path.join(BACKEND, 'shared-banks', b + '.json')
      if (!fs.existsSync(p)) continue
      const bank = JSON.parse(fs.readFileSync(p, 'utf-8'))
      const rows = (bank.questions || []).filter(q => !level || q.level === level)
      actual += rows.length
      years.push(...rows.map(q => Number(q.roc_year)))
    }
    // 共用題庫會被好幾個考試共用，重複加進全站合計會灌水，所以不計入 siteTotal
  } else continue

  let changed = false
  if (cfg.totalQ !== actual) {
    updates.push({ file, field: 'totalQ', from: cfg.totalQ, to: actual })
    cfg.totalQ = actual
    changed = true
  }
  if (cfg.seo && cfg.seo.totalQ !== undefined && cfg.seo.totalQ !== actual) {
    updates.push({ file, field: 'seo.totalQ', from: cfg.seo.totalQ, to: actual })
    cfg.seo.totalQ = actual
    changed = true
  }
  /*
   * seo.years 原本是手寫的（「100-115」「103 起」「104 至 115」三種寫法都有），
   * Home.jsx 直接把它印成「收錄 X 年度超過 N 題考古題」。
   * 99 年與 115 年補進題庫之後，26 個考試的這句話全都過期了
   *（獸醫寫 106-114、語言治療師寫 103 起，實際都是 99-115）。
   * 既然題數已經從題庫推，年度也一起推，才不會再漂。
   * 駕照題庫沒有 roc_year（用「113.11版」這種版本字串），沒有年度時不動。
   */
  const ys = [...new Set(years.filter(y => Number.isFinite(y) && y > 50 && y < 200))].sort((a, b) => a - b)
  for (const y of ys) siteYears.add(y)
  if (ys.length && cfg.seo) {
    const range = ys.length === 1 ? String(ys[0]) : `${ys[0]}-${ys[ys.length - 1]}`
    if (cfg.seo.years !== range) {
      updates.push({ file, field: 'seo.years', from: cfg.seo.years, to: range })
      cfg.seo.years = range
      changed = true
    }
  }

  if (changed) {
    atomicWriteJson(cfgPath, cfg)
    // mirror to frontend snapshot
    const snapPath = path.join(FRONTEND_SNAPSHOT, file)
    if (fs.existsSync(snapPath)) atomicWriteJson(snapPath, cfg)
  }
}

console.log(`✓ ${updates.length} 處更新`)
for (const u of updates.slice(0, 30)) {
  console.log(`   ${u.file.padEnd(25)} ${u.field.padEnd(12)} ${u.from} → ${u.to}`)
}
if (updates.length > 30) console.log(`   ... 還有 ${updates.length - 30}`)
console.log(``)
console.log(`📊 全站合計：${siteTotal.toLocaleString()} 題`)

/*
 * 把「幾種考試、幾題」寫成前端可以 import 的單一來源。
 *
 * 2026-10-27 之前這兩個數字是手寫在 6 個地方（index.html ×3、Home.jsx ×2、
 * Contact.jsx ×3、Privacy.jsx ×1），結果各說各話：
 *   Home「26 類國考 · 150,000+ 題」、Contact meta「26 類、150,000+」、
 *   Contact 內文「193,000+」「合計 27 類」、Privacy「合計 27 類、193,000+」
 * 而實際是 52 種考試、229,968 題。對外文案過期比沒寫還糟。
 *
 * ⚠️ 不能用 sum(totalQ) 當全站題數 —— 共用題庫被好幾個考試共用，
 *    加起來會灌水成 241,592。siteTotal 是上面自己累加、跳過 sharedBanks 的。
 */
const STATS_PATH = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'site-stats.json')
const examCount = fs.readdirSync(CONFIG_DIR).filter(f => f.endsWith('.json'))
  .filter(f => { try { return !!JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, f), 'utf-8')).id } catch { return false } })
  .length
const rounded = Math.floor(siteTotal / 10000) * 10000
const stats = {
  _comment: '由 backend/scripts/sync-total-q.js 產生，不要手改。題庫有增減就重跑那支。',
  exams: examCount,
  questions: siteTotal,
  // 對外文案用的保守整數，例如 229,968 → "220,000+"
  questionsRounded: rounded.toLocaleString('en-US') + '+',
  // 全站年度也從題庫推（手寫的那個停在 100-115，99 年補完就過期了）
  yearRange: (() => {
    const a = [...siteYears].sort((x, y) => x - y)
    return a.length ? `${a[0]}-${a[a.length - 1]}` : '100-115'
  })(),
  updated: new Date().toISOString().slice(0, 10),
}
if (fs.existsSync(path.dirname(STATS_PATH))) {
  atomicWriteJson(STATS_PATH, stats)
  console.log(`📝 site-stats.json：${stats.exams} 種考試、${stats.questions.toLocaleString()} 題（文案用 ${stats.questionsRounded}）`)
}

/*
 * index.html 的 meta/JSON-LD 是手寫的散文（七處），沒辦法安全地自動改寫，
 * 所以只做漂移檢查：裡面的數字跟 site-stats 對不上就出聲。
 * 2026-10-27 修之前它停在「17 類 / 合計 27 類 / 193,000+」，
 * 而 Home 寫「26 類 / 150,000+」、Contact 內文寫「193,000+」——
 * 四個地方四個說法，實際是 52 種、229,968 題。
 */
const INDEX_HTML = path.resolve(__dirname, '..', '..', 'frontend', 'index.html')
if (fs.existsSync(INDEX_HTML)) {
  const html = fs.readFileSync(INDEX_HTML, 'utf-8')
  const nums = [...new Set(html.match(/[0-9]{1,3},000\+/g) || [])]
  const stale = nums.filter(n => n !== stats.questionsRounded)
  const examNums = [...new Set((html.match(/合計 (\d+) 種考試/g) || []).map(m => m.match(/\d+/)[0]))]
  const staleExams = examNums.filter(n => Number(n) !== stats.exams)
  if (stale.length || staleExams.length) {
    console.log('')
    console.log(`⚠️  frontend/index.html 的數字跟 site-stats 對不上，要手動改：`)
    if (stale.length) console.log(`    題數寫 ${stale.join('、')}，應為 ${stats.questionsRounded}`)
    if (staleExams.length) console.log(`    考試數寫 ${staleExams.join('、')}，應為 ${stats.exams}`)
  }
}
