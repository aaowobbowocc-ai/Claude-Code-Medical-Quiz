#!/usr/bin/env node
/**
 * 拿商店的財務報表回頭標記 coin_orders 裡被退款的 IAP 訂單。
 *
 * 為什麼需要：RevenueCat 的退款 webhook 實際上沒有送達過。
 * payment-iap.js 有 REFUND_EVENTS 處理器（會寫 refunded_at），
 * 但 2026-09-09 那兩筆 Google Play 全額退款在我們這邊完全沒有紀錄，
 * coin_orders 仍是 status=paid、refunded_at 空的
 * → 收支報表把退掉的錢算成收入。
 *
 * 商店報表才是權威：
 *   Play   earnings_YYYYMM：Transaction Type = 'Charge refund'，Description 是 GPA 訂單號
 *   Apple  salesReports：Units 為負數的列（退款）
 *
 * ⚠️ **只標記訂單，不扣使用者的金幣。** 要不要追回是商業決定，
 *    而且扣幣是會被使用者看到的動作，不該由這支自動做。
 *
 *   node scripts/reconcile-iap-refunds.js --months=6        # 只看不改
 *   node scripts/reconcile-iap-refunds.js --months=6 --apply
 */
require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')
const play = require('./lib/play-earnings')
const apple = require('./lib/appstore-finance')

const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1]
const APPLY = process.argv.includes('--apply')
const MONTHS = Number(arg('months') || 6)

const ymList = n => {
  const out = []
  const d = new Date()
  for (let i = 0; i < n; i++) {
    out.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`)
    d.setMonth(d.getMonth() - 1)
  }
  return out.reverse()
}

;(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

  // ── 從商店報表收集「被退款的訂單號」────────────────────────────
  const refunded = new Map()   // providerOrderId -> {源, 月份, 金額}

  for (const ym of ymList(MONTHS)) {
    const r = await play.fetchEarnings(ym)
    if (!r.ok) { console.log(`  Play ${ym}：${String(r.error).slice(0, 70)}`); continue }
    let n = 0
    for (const row of r.rows) {
      if (!/refund/i.test(row['Transaction Type'] || '')) continue
      if (/fee/i.test(row['Transaction Type'] || '')) continue   // Google fee refund 是手續費退回，不是訂單退款
      const id = (row['Description'] || '').trim()
      if (!id) continue
      refunded.set(id, { src: 'Play', ym, amt: row['Amount (Buyer Currency)'], type: row['Refund Type'] || '' })
      n++
    }
    console.log(`  Play ${ym}：${r.rows.length} 列，退款 ${n} 筆`)
  }

  // Apple：salesReports 的 Units 為負數即退款
  for (const ym of ymList(MONTHS)) {
    const y = ym.slice(0, 4), m = ym.slice(4)
    const r = await apple.fetchReport({ kind: 'sales', reportDate: `${y}-${m}`, frequency: 'MONTHLY' })
    if (!r.ok) continue
    const neg = r.rows.filter(x => /^IA/.test(x['Product Type Identifier'] || '') && Number(x['Units'] || 0) < 0)
    if (neg.length) console.log(`  Apple ${ym}：退款 ${neg.length} 筆（salesReports 沒有訂單號，只能人工比對）`)
  }

  console.log(`\n商店報表裡共 ${refunded.size} 筆退款訂單號`)
  if (!refunded.size) { console.log('沒有要處理的。'); return }

  // ── 比對 coin_orders ─────────────────────────────────────────
  const { data, error } = await sb.from('coin_orders')
    .select('order_id,provider,amount_twd,coins,status,refunded_at,provider_order_id,user_id')
    .in('provider', ['google', 'apple']).range(0, 9999)
  if (error) { console.error('coin_orders:', error.message); process.exit(1) }

  const todo = []
  for (const o of data) {
    const hit = refunded.get((o.provider_order_id || '').trim())
    if (!hit) continue
    if (o.refunded_at) { console.log(`－ ${o.provider_order_id} 已經標過了`); continue }
    todo.push({ o, hit })
  }

  if (!todo.length) { console.log('coin_orders 裡沒有需要補標的。'); return }
  console.log(`\n要補標 ${todo.length} 筆：`)
  for (const { o, hit } of todo) {
    console.log(`  ${o.provider_order_id}  NT$${o.amount_twd}  ${o.coins} 幣  user=${String(o.user_id).slice(0, 8)}  ← ${hit.src} ${hit.ym} ${hit.type}`)
  }

  if (!APPLY) { console.log('\n（dry-run，加 --apply 才寫入）'); return }
  for (const { o, hit } of todo) {
    const { error: e } = await sb.from('coin_orders')
      .update({ refunded_at: new Date().toISOString(), refund_reason: `${hit.src}_REPORT_${hit.ym}` })
      .eq('order_id', o.order_id)
    if (e) console.error(`  ✗ ${o.provider_order_id}: ${e.message}`)
  }
  console.log(`\n✅ 已標記 ${todo.length} 筆。**金幣沒有扣**，要不要追回請自行決定。`)
})().catch(e => { console.error(e.stack); process.exit(1) })
