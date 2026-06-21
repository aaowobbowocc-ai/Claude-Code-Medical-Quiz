#!/usr/bin/env node
/**
 * 一次性：感謝 2026-05-18 以來的題目回報者。
 * - 10+ 則 → 10000 幣；3-9 則 → 3000 幣（皆透過 user_coin_grants，待認領）
 * - 3+ 則 → 發「好幫手」徽章（user_badges, source=admin）
 * 預設 dry-run，加 --apply 才寫入。冪等：已發過同一筆獎勵(同 reason 標記)會跳過。
 */
const fs = require('fs'), path = require('path')
const envContent = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf-8')
envContent.split('\n').forEach(line => { const i = line.indexOf('='); if (i > 0) process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim() })
const supabase = require('../supabase')
const APPLY = process.argv.includes('--apply')

const BADGE = {
  id: 'good_helper', name: '好幫手',
  description: '幫忙抓出題庫錯誤、讓題目更完善的好幫手',
  tier: 'limited', icon: '🛠️', unlock_type: 'admin', price_coins: 0, sort_order: 1,
}
const TAG = '[reporter-thanks-2026-06]' // reason 去重標記

const THANKS_10K = `謝謝你這段時間幫忙抓出超多題庫的錯誤！🛠️ 正是有你這麼細心又頻繁的回報，題庫才能越來越準確，幫到一起拚國考的大家。這 10000 金幣與專屬「好幫手」徽章請務必收下，是我們最大的感謝 🙏 ${TAG}`
const THANKS_3K  = `謝謝你幫忙回報題庫的錯誤！🛠️ 你的每一則回報都讓題目更正確、幫到更多備考的同學。這 3000 金幣與專屬「好幫手」徽章請收下，謝謝你的用心 🙏 ${TAG}`

// uid, 暱稱, 報數
const USERS = [
  // 10+ → 10000 + 徽章
  ['7d690a70-b2bf-4bf6-b03d-59f60b89b6e0', '胖呆', 41, 10000],
  ['df3e4aa7-66df-492e-81af-223f05854125', '蹦蹦', 20, 10000],
  ['13d56fc9-b2a7-4555-88f2-3016ebfe45e8', '讚讚蹦蹦', 11, 10000],
  ['9b1a4752-b509-4d93-ab4d-7608ffdbf503', '紅茶', 11, 10000],
  // 3-9 → 3000 + 徽章
  ['e5920911-c040-4efe-9bdc-b2a001dfb5a1', '醬板鴨', 8, 3000],
  ['2993d349-c84e-41db-9093-f1746d31e44c', '我', 7, 3000],
  ['db0b3e8d-b8bc-4cc0-b9cf-b1881e7d14a9', '楊迪欣', 6, 3000],
  ['17532102-4ab1-492d-a394-b70c05336b6d', '啊啊啊/要', 6, 3000],
  ['06520e13-42ff-4b61-834c-c4aa34b45cf4', 'Brian Chow', 5, 3000],
  ['f6db0b10-fe2f-4881-84b1-f290dd8eb195', '花', 5, 3000],
  ['4586fd30-6dfc-44b3-8346-d74433becb86', 'TMU洪子翔', 4, 3000],
  ['ee48bc2c-a355-41f7-aa3b-75b38b2f78fd', 'Paul', 3, 3000],
]

async function main() {
  if (!supabase) { console.error('Supabase 未連線'); process.exit(1) }
  console.log(`\n=== 回報者感謝獎勵 ${APPLY ? '(APPLY)' : '(dry-run)'} ===\n`)

  // 1) badge upsert
  if (APPLY) {
    const { error } = await supabase.from('badges').upsert(BADGE, { onConflict: 'id' })
    if (error) { console.error('badge upsert 失敗:', error.message); process.exit(1) }
    console.log(`✓ 徽章已建立/更新：${BADGE.icon} ${BADGE.name}\n`)
  } else {
    console.log(`(將建立徽章：${BADGE.icon} ${BADGE.name})\n`)
  }

  let totalCoins = 0
  for (const [uid, name, n, coins] of USERS) {
    // 去重：是否已有同標記獎勵
    const { data: existing } = await supabase.from('user_coin_grants')
      .select('id').eq('user_id', uid).ilike('reason', `%${TAG}%`).limit(1)
    if (existing && existing.length) { console.log(`⏭  ${name} (${n}則) 已發過，跳過`); continue }

    const reason = coins >= 10000 ? THANKS_10K : THANKS_3K
    console.log(`${APPLY ? '→' : '·'} ${name.padEnd(10)} ${n}則 → ${coins}幣 + 好幫手徽章`)
    totalCoins += coins
    if (APPLY) {
      const { error: gErr } = await supabase.from('user_coin_grants')
        .insert({ user_id: uid, coins, reason, from_name: '平台團隊' })
      if (gErr) { console.error(`  ❌ 金幣失敗 ${name}: ${gErr.message}`); continue }
      const { error: bErr } = await supabase.from('user_badges')
        .upsert({ user_id: uid, badge_id: BADGE.id, source: 'admin' }, { onConflict: 'user_id,badge_id' })
      if (bErr) console.error(`  ⚠ 徽章失敗 ${name}: ${bErr.message}`)
    }
  }
  console.log(`\n合計 ${USERS.length} 人，金幣 ${totalCoins}（皆待認領，使用者登入後領取）`)
  if (!APPLY) console.log('(dry-run，未寫入；加 --apply 執行)')
}
main().catch(e => { console.error(e); process.exit(1) })
