#!/usr/bin/env node
/**
 * 批次發 1000 金幣給所有 profiles 用戶。
 *
 * 用法：
 *   node scripts/grant-coins-all.js --dry-run
 *   node scripts/grant-coins-all.js --confirm
 *
 * 安全鎖：必須帶 --confirm 才會真的寫入。--dry-run 只列數量。
 */
require('dotenv/config')
const supabase = require('../supabase')

const COINS = 2000
const REASON = '🎉 國考知識王正式上架 App Store + Google Play！\n習慣用網頁的朋友無須更動，網站一樣即時更新。\n覺得好用歡迎推薦給學弟妹並到商店留下評論 🙏\n這 2000 金幣請收下，祝大家國考順利、金榜題名！'
const FROM_NAME = '平台團隊'
const CHUNK = 500

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const confirm = args.includes('--confirm')

  if (!supabase) { console.error('Supabase 未連線'); process.exit(1) }
  if (!dryRun && !confirm) {
    console.error('安全鎖：必須帶 --confirm 或 --dry-run')
    process.exit(1)
  }

  // Pull all user_ids
  console.log('正在拉取所有 profiles...')
  const allUserIds = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await supabase.from('profiles').select('user_id').range(from, from + PAGE - 1)
    if (error) { console.error('查詢失敗:', error.message); process.exit(1) }
    if (!data.length) break
    for (const p of data) if (p.user_id) allUserIds.push(p.user_id)
    if (data.length < PAGE) break
    from += PAGE
  }
  console.log(`共 ${allUserIds.length} 個使用者`)
  console.log(`每人 ${COINS} 金幣`)
  console.log(`訊息：\n${REASON}\n`)

  if (dryRun) {
    console.log('[dry-run] 不執行寫入')
    return
  }

  // Batch insert
  let success = 0
  let failed = 0
  for (let i = 0; i < allUserIds.length; i += CHUNK) {
    const slice = allUserIds.slice(i, i + CHUNK)
    const rows = slice.map(uid => ({
      user_id: uid,
      coins: COINS,
      reason: REASON,
      from_name: FROM_NAME,
    }))
    const { error } = await supabase.from('user_coin_grants').insert(rows)
    if (error) {
      console.error(`  ✗ chunk ${i}-${i+slice.length}: ${error.message}`)
      failed += slice.length
    } else {
      success += slice.length
      process.stdout.write(`\r  發放進度: ${success}/${allUserIds.length}`)
    }
  }
  console.log(`\n=== 完成: ${success} 成功 / ${failed} 失敗 ===`)
}

main().catch(e => { console.error(e); process.exit(1) })
