#!/usr/bin/env node
/**
 * 收入／成本月報。
 *
 * 目前能自動抓的：
 *   ✅ 金幣銷售（Supabase coin_orders）——街口支付 + App 內購，毛額
 *   ✅ 使用量（ai_explanations / profiles）——拿來算「單則 AI 解說成本」
 *   ✅ 雲端成本——歷史看 backend/_finance/ 的費用表 CSV，之後看 BigQuery 帳單匯出
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

const money = n => (n < 0 ? '−NT$' : 'NT$') + Math.abs(Math.round(n)).toLocaleString('en-US')
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

function parseCSV(text) {
  const rows = []
  let row = [], cur = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++ } else q = false } else cur += c }
    else if (c === '"') q = true
    else if (c === ',') { row.push(cur); cur = '' }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = '' }
    else if (c !== '\r') cur += c
  }
  if (cur || row.length) { row.push(cur); rows.push(row) }
  return rows
}

/**
 * 讀 Cloud Billing 「費用表」下載的 CSV（放在 backend/_finance/）。
 *
 * BigQuery 匯出**不回填歷史**，開通之前的月份只能靠這些 CSV。
 *
 * ⚠️ 兩個會算錯的地方：
 *  1. 欄位 index：費用類型=11、抵免額類型=10、**費用=17**（不是 18）。
 *  2. **抵免是負值**。只加正數的話，2026-05 會算成毛額 9,954 而不是實付 585——
 *     那個月有 −9,397 的 PROMOTION（Google Cloud 試用金）把帳單蓋掉了。
 *     報表兩個都要顯示：毛額看真實成本，實付看實際掏了多少錢。
 */
function gcpCostFromCsv() {
  const dir = path.join(ROOT, '_finance')
  if (!fs.existsSync(dir)) return {}
  const byMonth = {}
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.csv'))) {
    const m = (f.match(/(\d{4}-\d{2})-\d{2}/) || [])[1]
    if (!m) continue
    const rows = parseCSV(fs.readFileSync(path.join(dir, f), 'utf8'))
    const hi = rows.findIndex(r => r[0] === '帳單帳戶名稱')
    if (hi < 0) continue
    const b = byMonth[m] = { total: 0, gross: 0, credit: 0, byService: {}, currency: 'TWD', source: 'CSV' }
    for (const r of rows.slice(hi + 1)) {
      const credType = r[10], type = r[11], svc = r[5] || '其他', cost = parseFloat(r[17] || '0') || 0
      if (!type) continue
      if (type === '總計') { b.total = cost; continue }
      if (credType) { b.credit += cost; b.byService[svc] = (b.byService[svc] || 0) + cost }
      else if (type === '用量') { b.gross += cost; b.byService[svc] = (b.byService[svc] || 0) + cost }
    }
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
  if (!t) { console.log('⏳ 帳單匯出已設定，但還沒有資料（Google 要 4~24 小時才會寫第一批）'); return null }
  const sql = `
    SELECT FORMAT_TIMESTAMP('%Y-%m', usage_start_time) AS month,
           service.description AS service,
           SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS net_cost,
           currency
    FROM \`${project}.${dataset}.${t.id}\`
    GROUP BY month, service, currency
    ORDER BY month DESC, net_cost DESC`
  const [rows] = await bq.query({ query: sql })
  // 表建好了但還沒有資料是正常的：Google 只匯出**啟用之後**產生的用量，
  // 而且是每天批次寫一次。空表不等於設定失敗。
  if (!rows.length) {
    console.log('⏳ 帳單匯出的資料表已經建好，但還是空的（Google 只寫啟用之後的用量，每天批次一次）')
    return null
  }
  const byMonth = {}
  for (const r of rows) {
    const b = byMonth[r.month] || (byMonth[r.month] = { total: 0, byService: {}, currency: r.currency })
    b.total += Number(r.net_cost || 0)
    b.byService[r.service] = (b.byService[r.service] || 0) + Number(r.net_cost || 0)
    b.source = 'BigQuery'
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
  const bq = await gcpCost().catch(e => { console.log('⚠️ 讀 BigQuery 帳單失敗:', e.message.slice(0, 80)); return null })
  // 同一個月兩邊都有的話以 BigQuery 為準（比較新），沒有的月份用下載的 CSV 補
  const gcp = { ...gcpCostFromCsv(), ...(bq || {}) }
  const hasGcp = Object.keys(gcp).length > 0
  const fixed = fixedCosts()

  const months = [...new Set([...Object.keys(rev.byMonth), ...Object.keys(use), ...Object.keys(gcp)])]
    .filter(m => !ONLY_MONTH || m === ONLY_MONTH).sort()

  console.log('\n══════════ 國考知識王 收支月報 ══════════\n')
  let totalRev = 0, totalCost = 0
  for (const m of months) {
    const r = rev.byMonth[m] || { gross: 0, refund: 0, byProvider: {} }
    const net = r.gross - r.refund
    const g = gcp[m]
    const ai = use[m] || 0
    totalRev += net
    if (g) totalCost += g.total

    console.log(`${m}`)
    const src = Object.entries(r.byProvider).map(([k, v]) => `${k} ${money(v)}`).join('、') || '—'
    console.log(`  金幣銷售（毛）  ${money(net)}${r.refund ? `（已扣退款 ${money(r.refund)}）` : ''}   ${src}`)
    if (g) {
      const top = Object.entries(g.byService).sort((a, b) => b[1] - a[1]).slice(0, 2)
        .map(([k, v]) => `${k} ${v.toFixed(0)}`).join('、')
      const paid = g.total || (g.gross + g.credit)
      // 抵免額蓋掉的部分一定要講出來——試用金用完之後那才是真正的帳單
      const creditNote = g.credit ? `（毛額 ${money(g.gross)}，抵免 ${money(g.credit)}）` : ''
      console.log(`  雲端成本        ${money(paid)}${creditNote}   ${top}`)
    }
    if (ai) {
      const unit = g && ai ? ` → 單則約 NT$${((g.total || 0) / ai).toFixed(2)}（以毛額算 NT$${((g.gross || g.total || 0) / ai).toFixed(2)}）` : ''
      console.log(`  AI 解說         ${ai.toLocaleString('en-US')} 則${unit}`)
    }
    console.log('')
  }

  console.log('──────── 合計 ────────')
  console.log(`金幣銷售（毛額，未扣通路抽成）  ${money(totalRev)}`)
  const totalGross = Object.values(gcp).reduce((a, b) => a + (b.gross || b.total || 0), 0)
  if (hasGcp) {
    console.log(`雲端成本（實付）                ${money(totalCost)}`)
    if (Math.abs(totalGross - totalCost) > 1) {
      console.log(`雲端成本（毛額，抵免前）        ${money(totalGross)}  ⚠️ 差額是試用／促銷金，用完就沒了`)
    }
  } else console.log(`雲端成本                        （未接上，見檔頭說明）`)
  console.log(`固定成本攤提                    ${money(fixed.monthly)}／月`)
  console.log(`結帳流失                        完成 ${rev.paid} 筆 / 未完成 ${rev.abandoned} 筆`)
  if (fixed.warnings.length) {
    console.log('\n⚠️ ' + fixed.warnings.join('\n⚠️ '))
  }
  console.log(`
還沒接上的資料來源：
  Google Play 實收 → Play Console 的財務報表 GCS bucket（現在看到的是使用者付的錢，沒扣 Google 抽成）
  Apple 實收     → App Store Connect API（需要 Finance 角色的金鑰；上架後才有數字）
  AdMob 收益     → AdMob API（只支援 OAuth）`)
  if (!bq) console.log(`  ${'（BigQuery 帳單匯出已設定，還在等 Google 寫第一批資料）'}`)
})().catch(e => { console.error(e.stack); process.exit(1) })
