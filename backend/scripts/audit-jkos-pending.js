#!/usr/bin/env node
/**
 * 把 coin_orders 裡 status=pending 的街口訂單，逐筆向街口 /platform/inquiry 查真實狀態。
 *
 * 為什麼要查：我們這邊 pending 只代表「建了單、沒收到 callback」。
 * 如果街口那邊其實是成功的，就是**使用者付了錢沒拿到金幣** —— 要補幣。
 * 反之若街口也查無或未付款，那就是單純的結帳放棄，是轉換率問題不是事故。
 *
 * ⚠️ 唯讀。只呼叫 /platform/inquiry，不會動任何訂單。
 *
 * ⚠️ **一定要確認 JKOS_API_HOST 是正式環境。**
 *    本機 .env 設的是 `https://uat-onlinepay.jkopay.app`（UAT 測試環境），
 *    拿它去查正式環境的訂單號會每一筆都回空 `{}`。
 *    2026-10-27 第一次跑就是這樣，39 筆全部「查詢失敗」，
 *    而我一開始把它誤讀成「沒有人付錢沒入帳」。
 *    查詢失敗 ≠ 未付款。要在 Oracle 後端（有正式憑證）上跑，
 *    或把正式 host/key/secret 帶進環境變數。
 *
 *   node scripts/audit-jkos-pending.js
 */
require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')
const { inquireJkosOrder } = require('../payment-jkos')

const TEST_USERS = new Set(['0e727540-2fae-499a-bca2-3218cecc3600'])

;(async () => {
  const host = process.env.JKOS_API_HOST || ''
  if (/uat-/.test(host)) {
    console.error(`✗ JKOS_API_HOST 是 UAT 測試環境（${host}）。`)
    console.error('  用它查正式環境的訂單號會每一筆都回空 {}，而「查詢失敗」不等於「未付款」。')
    console.error('  請在 Oracle 後端上跑，或先設好正式環境的 JKOS_API_HOST / JKOS_API_KEY / JKOS_SECRET_KEY。')
    process.exit(2)
  }
  console.log(`街口 API host：${host}\n`)
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  const { data, error } = await sb.from('coin_orders')
    .select('order_id,user_id,provider,amount_twd,coins,status,created_at')
    .eq('provider', 'jkos').is('paid_at', null).range(0, 9999)
  if (error) { console.error('coin_orders:', error.message); process.exit(1) }

  const rows = data.filter(o => !TEST_USERS.has(o.user_id))
  console.log(`街口未完成訂單 ${rows.length} 筆（已排除開發者本人測試）\n`)

  const bucket = {}
  const paidButNotCredited = []
  for (const o of rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
    let tx = null, err = null
    try { tx = await inquireJkosOrder(o.order_id) } catch (e) { err = e.message }
    const st = err ? `查詢失敗：${err.slice(0, 48)}` : (tx ? (tx.status || JSON.stringify(tx).slice(0, 60)) : '街口查無此單')
    const key = err ? '查詢失敗' : (tx ? `街口狀態=${tx.status}` : '街口查無此單')
    bucket[key] = (bucket[key] || 0) + 1
    // 街口認為成功 → 使用者付了錢我們沒入帳
    if (tx && /^(S|success|SUCCESS|paid)/i.test(String(tx.status || ''))) {
      paidButNotCredited.push({ ...o, tx })
    }
    console.log(`${String(o.created_at).slice(0, 16)}  NT$${String(o.amount_twd).padStart(4)}  ${o.order_id}  → ${st}`)
  }

  console.log('\n──── 彙整 ────')
  for (const [k, v] of Object.entries(bucket).sort((a, b) => b[1] - a[1])) console.log(`  ${v} 筆  ${k}`)

  const failed = bucket['查詢失敗'] || 0
  if (paidButNotCredited.length) {
    console.log(`\n🚨 街口顯示已付款但我們沒入帳：${paidButNotCredited.length} 筆，共 NT$${paidButNotCredited.reduce((s, o) => s + Number(o.amount_twd || 0), 0)}`)
    for (const o of paidButNotCredited) console.log(`   ${o.order_id}  user=${o.user_id}  ${o.coins} 幣  NT$${o.amount_twd}`)
    console.log('   → 用 procedure_coin_distribution 的 grant-coins.js 補幣')
  }
  // ⚠️ 查詢失敗不是「未付款」。有失敗就不能下任何結論。
  if (failed) {
    console.log(`\n⚠️ 有 ${failed} / ${rows.length} 筆查詢失敗，這些**狀態未知**，不要當成結帳放棄。`)
    console.log('   先確認 host／憑證是正式環境、以及來源 IP 是否在街口的白名單內（JKOS_EXTRA_IPS）。')
  } else if (!paidButNotCredited.length) {
    console.log('\n✅ 全部查詢成功，且沒有「付了錢沒入帳」的情況 —— 這些是單純的結帳放棄')
  }
})().catch(e => { console.error(e.stack); process.exit(1) })
