#!/usr/bin/env node
/**
 * 郵政（內勤／外勤）全部 1,098 題的 `subject` 都是「專業科目」，而 exam-config
 * 宣告的兩卷是「企業管理大意」與「郵政三法大意」／「郵政法大意及交通安全常識」。
 *
 * 後果不是難看而已 —— **模考整個不能用**：
 *   前端 lib/cdnQuestions.js 的 getRandomPaper 是 `valid.filter(q => q.subject === subject)`，
 *   subject 來自 config 的 paper.subject，所以每一卷都撈到 0 題，
 *   `data.questions.length >= 10` 不成立 → 退回後端 → 後端同樣對不上，
 *   使用者看到的是「題目不足或載入失敗，請稍後再試」。歷屆模式同理。
 *
 * 後端 server.js 還有一條「比例切卷」的退路（照年份內的位置按比例分給各卷），
 * 但題庫是**整卷接整卷**存的、config 的順序又相反，所以切出來幾乎全錯：
 *   114 內勤 110 題，比例切法 110 題全部分到錯的卷。
 *
 * 真正的卷別資訊一直都在 `subject_tag`（post_law／post_mgmt），只是 server.js 的
 * 直接配對那條路只看 `q.subject`。把 subject 補成該卷的名字，三條路就都對了，
 * 順帶解掉 418 組「同卷同科目同題號」的假碰撞（兩卷題號本來就都從 1 開始）。
 *
 * subject_name 不動 —— 那是逐年的正式科目名（「企業管理大意及洗錢防制法大意」
 * 之類），比 config 的通稱精確，是另一個用途。
 *
 *   node scripts/fix-post-subject-field.js
 *   node scripts/fix-post-subject-field.js --apply
 */
const fs = require('fs')
const path = require('path')
const { atomicWriteJson } = require('./lib/atomic-write')

const BK = path.join(__dirname, '..')
const APPLY = process.argv.includes('--apply')

// subject_tag → exam-config 裡 papers[].id
const TAG2PAPER = { post_law: 'law', post_mgmt: 'mgmt' }

let total = 0
for (const exam of ['post-indoor', 'post-outdoor']) {
  const fp = path.join(BK, `questions-${exam}.json`)
  const cfgPath = path.join(BK, 'exam-configs', `${exam}.json`)
  if (!fs.existsSync(fp) || !fs.existsSync(cfgPath)) { console.log(`${exam}: 找不到題庫或設定，跳過`); continue }
  const j = JSON.parse(fs.readFileSync(fp, 'utf8'))
  const arr = Array.isArray(j) ? j : j.questions
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  const byId = {}
  for (const p of cfg.papers || []) byId[p.id] = p.subject || p.name

  const tally = {}
  let changed = 0, unknown = 0
  for (const q of arr) {
    const pid = TAG2PAPER[q.subject_tag]
    const want = pid && byId[pid]
    if (!want) { unknown++; continue }
    if (q.subject === want) continue
    tally[`${q.subject} → ${want}`] = (tally[`${q.subject} → ${want}`] || 0) + 1
    if (APPLY) q.subject = want
    changed++
  }
  console.log(`\n${exam}：${changed} 題改 subject${unknown ? `，${unknown} 題的 subject_tag 不認得（原樣保留）` : ''}`)
  for (const [k, v] of Object.entries(tally)) console.log(`   ${k}　${v} 題`)

  // 驗收：模考每一卷撈得到幾題
  for (const p of cfg.papers || []) {
    const want = p.subject || p.name
    const n = arr.filter(q => q.subject === want).length
    console.log(`   模考「${p.name}」（要 ${p.count} 題）→ ${n} 題${n < Math.max(10, p.count) ? '  ⚠️ 不足' : '  ✓'}`)
  }
  if (APPLY && changed) atomicWriteJson(fp, j)
  total += changed
}

console.log(`\n${APPLY ? '已改 ' : '可改 '}${total} 題`)
if (!APPLY) console.log('(試跑；加 --apply 才寫入)')
