#!/usr/bin/env node
/**
 * 收入／成本月報。
 *
 * 目前能自動抓的：
 *   ✅ 金幣銷售（Supabase coin_orders）——街口支付 + App 內購，毛額
 *   ✅ 使用量（ai_explanations / profiles）——拿來算「單則 AI 解說成本」
 *   ⏳ Vertex AI 花費（BigQuery 帳單匯出）——要先在 Cloud Billing 開匯出，見下方
 *   ⏳ Google Play 實收（Play Console 丟進 GCS 的財務報表）
 *   ⏳ Apple 實收（App Store Connect API，需要 Finance 角色的金鑰）
 *   ⏳ AdMob 收益（AdMob API，只支援 OAuth）
 *   📝 固定成本（finance-fixed-costs.json，手填）
 *
 * ⚠️ coin_orders 的金額是**使用者付的錢**，不是你實收的錢。
 *    Google Play 抽 15~30%、Apple 抽 15~30%、街口另有手續費。
 *    接上 Play / Apple 的財務報表之後才看得到扣成後的數字。
 *
 * 用法：
 *   node scripts/finance-report.js              # 全部月份
 *   node scripts/finance-report.js --month 2026-09
 */
require('dotenv').config({ quiet: true })
const fs = require('fs')
const path = require('path')
const { createClient } = require('@supabase/supabase-js')

const ROOT = path.join(__dirname, '..')
const arg = k => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null }
const ONLY_MONTH = arg('--month')

// ── BigQuery 帳單匯出（尚未啟用時整段跳過）────────────────────────────
// 啟用步驟（只能在 Console 做，沒有 API）：
//   Cloud Billing → 帳單匯出 → 標準用量成本 → 選一個 BigQuery dataset
//   然後把 dataset 名稱填進 .env：GCP_BILLING_DATASET=<project>.<dataset>
// ⚠️ 匯出只從啟用當下開始累積，不會回填歷史。
const BILLING_DATASET = process.env.GCP_BILLING_DATASET || ''

const money = n => 'NT$' + Math.round(n).toLocaleString('en-US')
const ym = d => String(d).slice(0, 7)

async function coinRevenue(sb) {
  const { data, error } = await sb
    .from('coin_orders')
    .select('provider,amount_twd,status,paid_at,created_at')
    .range(0, 9999)   // PostgREST 預設只回 1000 列，要用 range 才拿得到更多
  if (error) throw new Error('coin_orders: ' + error.message)
  const byMonth = {}
  for (const o of data) {
    // 只認真的付過錢的：paid 算收入，refunded 當月扣回去
    if (o.status !== 'paid' && o.status !== 'refunded') continue
    const m = ym(o.paid_at || o.created_at)
    const b = byMonth[m] || (byMonth[m] = { gross: 0, refund: 0, byProvider: {} })
    const amt = Number(o.amount_twd || 0)
    if (o.status === 'refunded') b.refund += amt
    else { b.gross += amt; b.byProvider[o.provider] = (b.byProvider[o.provider] || 0) + amt }
  }
  // 沒付款的單子單獨算，拿來看結帳流失
  const abandoned = data.filter(o => o.status === 'pending').length
  const paid = data.filter(o => o.status === 'paid').length
  return { byMonth, abandoned, paid }
}

/**
 * 每月的 AI 解說則數。
 * ⚠️ PostgREST 預設最多回 1000 列，`.limit(500000)` 是沒用的——
 *    第一版就是這樣，14.7 萬則只數到 1000 則（五月 999、六月 1）。
 *    改成逐月下 count 查詢，不把資料拉回來。
 */
async function usage(sb) {
  const { data: first } = await sb.from('ai_explanations')
    .select('created_at').order('created_at', { ascending: true }).limit(1)
  if (!first || !first.length) return {}
  const byMonth = {}
  const start = new Date(first[0].created_at)
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  const now = new Date()
  while (cur <= now) {
    const next = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1))
    const { count } = await sb.from('ai_explanations')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', cur.toISOString())
      .lt('created_at', next.toISOString())
    if (count) byMonth[cur.toISOString().slice(0, 7)] = count
    cur.setUTCMonth(cur.getUTCMonth() + 1)
  }
  return byMonth
}

/** BigQuery 帳單匯出。沒設 GCP_BILLING_DATASET 就回 null。 */
async function gcpCost() {
  if (!BILLING_DATASET) return null
  let BigQuery
  try { ({ BigQuery } = require('@google-cloud/bigquery')) }
  catch { console.log('⚠️ 要裝 @google-cloud/bigquery 才能讀帳單'); return null }
  const [project, dataset] = BILLING_DATASET.split('.')
  const bq = new BigQuery({ projectId: project })
  // 匯出的表名長這樣：gcp_billing_export_v1_<BILLING_ACCOUNT_ID 把 - 換成 _>
  const [tables] = await bq.dataset(dataset).getTables()
  const t = tables.find(x => x.id.startsWith('gcp_billing_export_v1_'))
  if (!t) { console.log('⚠️ dataset 裡找不到 gcp_billing_export_v1_* 表，匯出可能還沒開始寫入'); return null }
  const sql = `
    SELECT FORMAT_TIMESTAMP('%Y-%m', usage_start_time) AS month,
           service.description AS service,
           SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS net_cost,
           currency
    FROM \`${project}.${dataset}.${t.id}\`
    GROUP BY month, service, currency
    ORDER BY month DESC, net_cost DESC`
  const [rows] = await bq.query({ query: sql })
  const byMonth = {}
  for (const r of rows) {
    const b = byMonth[r.month] || (byMonth[r.month] = { total: 0, byService: {}, currency: r.currency })
    b.total += Number(r.net_cost || 0)
    b.byService[r.service] = (b.byService[r.service] || 0) + Number(r.net_cost || 0)
  }
  return byMonth
}

function fixedCosts() {
  const p = path.join(ROOT, 'finance-fixed-costs.json')
  if (!fs.existsSync(p)) return { monthly: 0, warnings: [] }
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'))
  let monthly = 0
  const warnings = []
  const now = new Date()
  for (const it of cfg.items || []) {
    if (it.cycle === 'yearly') monthly += Number(it.amount_twd || 0) / 12
    else if (it.cycle === 'monthly') monthly += Number(it.amount_twd || 0)
    if (it.renews_on) {
      const days = Math.round((new Date(it.renews_on) - now) / 86400000)
      if (days >= 0 && days <= 45) warnings.push(`${it.name} 還有 ${days} 天續約（${it.renews_on}）`)
    }
    if (!it.amount_twd) warnings.push(`${it.name} 的金額還沒填`)
  }
  return { monthly, warnings }
}

;(async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error('缺 SUPABASE_URL / SUPABASE_KEY'); process.exit(1)
  }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  const rev = await coinRevenue(sb)
  const use = await usage(sb)
  const gcp = await gcpCost().catch(e => { console.log('⚠️ 讀帳單失敗:', e.message.slice(0, 80)); return null })
  const fixed = fixedCosts()

  const months = [...new Set([...Object.keys(rev.byMonth), ...Object.keys(use), ...Object.keys(gcp || {})])]
    .filter(m => !ONLY_MONTH || m === ONLY_MONTH).sort()

  console.log('\n══════════ 國考知識王 收支月報 ══════════\n')
  let totalRev = 0, totalCost = 0
  for (const m of months) {
    const r = rev.byMonth[m] || { gross: 0, refund: 0, byProvider: {} }
    const net = r.gross - r.refund
    const g = (gcp || {})[m]
    const ai = use[m] || 0
    totalRev += net
    if (g) totalCost += g.total

    console.log(`${m}`)
    const src = Object.entries(r.byProvider).map(([k, v]) => `${k} ${money(v)}`).join('、') || '—'
    console.log(`  金幣銷售（毛）  ${money(net)}${r.refund ? `（已扣退款 ${money(r.refund)}）` : ''}   ${src}`)
    if (g) {
      const top = Object.entries(g.byService).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([k, v]) => `${k} ${v.toFixed(2)}`).join('、')
      console.log(`  雲端成本        ${g.total.toFixed(2)} ${g.currency}   ${top}`)
    }
    if (ai) {
      const unit = g && ai ? ` → 單則約 ${(g.total / ai).toFixed(4)} ${g.currency}` : ''
      console.log(`  AI 解說         ${ai.toLocaleString('en-US')} 則${unit}`)
    }
    console.log('')
  }

  console.log('──────── 合計 ────────')
  console.log(`金幣銷售（毛額，未扣通路抽成）  ${money(totalRev)}`)
  if (gcp) console.log(`雲端成本                        ${totalCost.toFixed(2)}`)
  else console.log(`雲端成本                        （未接上，見檔頭說明）`)
  console.log(`固定成本攤提                    ${money(fixed.monthly)}／月`)
  console.log(`結帳流失                        完成 ${rev.paid} 筆 / 未完成 ${rev.abandoned} 筆`)
  if (fixed.warnings.length) {
    console.log('\n⚠️ ' + fixed.warnings.join('\n⚠️ '))
  }
  if (!gcp) {
    console.log(`
還沒接上的資料來源（接上之後這張報表才完整）：
  Vertex AI 花費 → Cloud Billing 開「匯出到 BigQuery」，再把 dataset 填進 .env 的 GCP_BILLING_DATASET
  Google Play 實收 → Play Console 的財務報表 GCS bucket
  Apple 實收     → App Store Connect API（需要 Finance 角色的金鑰）
  AdMob 收益     → AdMob API（只支援 OAuth）`)
  }
})().catch(e => { console.error(e.stack); process.exit(1) })
