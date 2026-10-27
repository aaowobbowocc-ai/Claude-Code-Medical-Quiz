#!/usr/bin/env node
/**
 * 把 App Store 與 Google Play 的**實收**（扣完平台抽成）拉出來。
 *
 * 為什麼需要：coin_orders 記的是**買家付的錢**，沒扣 Apple／Google 的抽成，
 * 所以收支報表裡的「金幣銷售」一直是毛額。這支補上淨額那一半。
 *
 *   node scripts/fetch-store-revenue.js              # 近 3 個月
 *   node scripts/fetch-store-revenue.js --months=6
 *
 * Apple：用 salesReports 的 Developer Proceeds 欄。
 *   ⚠️ 不要等 financeReports —— 那個要 Apple 實際撥款後才會有資料，
 *      iOS IAP 2026-10-05 才上線，第一份財務報表大概要等到 11 月底。
 *      salesReports 當天就有，而且 Developer Proceeds 已經是淨額。
 *
 * Play：earnings_YYYYMM.zip 裡的 CSV，每列一種交易類型
 *   （Charge / Google fee / Tax / ...refund），把金額加總就是淨額。
 *   ⚠️ 服務帳戶要在 Play Console 有「查看財務資料」的**帳戶層級（全域）**權限。
 */
require('dotenv').config()
const apple = require('./lib/appstore-finance')
const play = require('./lib/play-earnings')

const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1]
const MONTHS = Number(arg('months') || 3)

const ymList = n => {
  const out = []
  const d = new Date()
  for (let i = 0; i < n; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
    d.setMonth(d.getMonth() - 1)
  }
  return out.reverse()
}
const money = n => (n < 0 ? '−' : '') + Math.abs(n).toFixed(2)

async function appleMonth(ym) {
  // 先試整月；拿不到（當月還沒結算）就逐日累加
  const m = await apple.fetchReport({ kind: 'sales', reportDate: ym, frequency: 'MONTHLY' })
  let rows = m.ok ? m.rows : []
  let note = m.ok ? '' : '（整月報表還沒出，改用逐日）'
  if (!m.ok) {
    const [y, mo] = ym.split('-').map(Number)
    const last = new Date(y, mo, 0).getDate()
    for (let d = 1; d <= last; d++) {
      const day = `${ym}-${String(d).padStart(2, '0')}`
      const r = await apple.fetchReport({ kind: 'sales', reportDate: day, frequency: 'DAILY' })
      if (r.ok) rows = rows.concat(r.rows)
    }
  }
  let gross = 0, net = 0, units = 0, cur = ''
  for (const r of rows) {
    if (!/^IA/.test(r['Product Type Identifier'] || '')) continue   // 只看 App 內購
    const u = Number(r['Units'] || 0)
    units += u
    gross += Number(r['Customer Price'] || 0) * u
    net += Number(r['Developer Proceeds'] || 0) * u
    cur = cur || r['Currency of Proceeds'] || r['Customer Currency'] || ''
  }
  return { units, gross, net, cur, note }
}

async function playMonth(ym) {
  const r = await play.fetchEarnings(ym.replace('-', ''))
  if (!r.ok) return { error: r.error, status: r.status }
  // 欄名在不同年份的報表略有差異，取第一個含「Merchant Currency」的金額欄
  const amtKey = Object.keys(r.rows[0] || {}).find(k => /Amount.*Merchant Currency/i.test(k))
  const curKey = Object.keys(r.rows[0] || {}).find(k => /Merchant Currency$/i.test(k) && !/Amount/i.test(k))
  if (!amtKey) return { error: `報表裡找不到金額欄，欄位有：${Object.keys(r.rows[0] || {}).join(', ')}` }
  const byType = {}
  let net = 0, cur = ''
  for (const row of r.rows) {
    const v = Number(String(row[amtKey]).replace(/,/g, '')) || 0
    const t = row['Transaction Type'] || '?'
    byType[t] = (byType[t] || 0) + v
    net += v
    cur = cur || row[curKey] || ''
  }
  return { net, cur, byType, n: r.rows.length }
}

;(async () => {
  const months = ymList(MONTHS)
  console.log(`══ 平台實收（扣完抽成）近 ${MONTHS} 個月 ══\n`)

  console.log('── App Store ──')
  for (const ym of months) {
    try {
      const a = await appleMonth(ym)
      if (!a.units) { console.log(`  ${ym}  無 App 內購`); continue }
      const fee = a.gross - a.net
      console.log(`  ${ym}  ${a.units} 筆｜買家付 ${money(a.gross)}｜實收 ${money(a.net)} ${a.cur}｜Apple 抽 ${money(fee)}（${(fee / a.gross * 100).toFixed(1)}%）${a.note}`)
    } catch (e) { console.log(`  ${ym}  ✗ ${e.message}`) }
  }

  console.log('\n── Google Play ──')
  for (const ym of months) {
    const p = await playMonth(ym)
    if (p.error) {
      console.log(`  ${ym}  ✗ ${p.status ? 'HTTP ' + p.status + ' ' : ''}${String(p.error).slice(0, 110)}`)
      continue
    }
    console.log(`  ${ym}  ${p.n} 列｜實收合計 ${money(p.net)} ${p.cur}`)
    for (const [t, v] of Object.entries(p.byType).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])))
      console.log(`         ${t.padEnd(22)} ${money(v)}`)
  }

  console.log('\n※ coin_orders 記的是買家付的錢（毛額）；上面是扣完平台抽成的實收。')
})().catch(e => { console.error(e.stack); process.exit(1) })
