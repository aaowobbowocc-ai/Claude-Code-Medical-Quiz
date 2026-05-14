#!/usr/bin/env node
/**
 * 補傳 Supabase 內 feedback + reports 到 Discord
 * (使用者上次處理到 2026-05-10，之後的因 Oracle .env 缺 webhook 全部沒響)
 */
require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')

const FB_WEBHOOK = 'https://discord.com/api/webhooks/1490189536506937426/5fC6DUZ0mgqeFRzitgim7iPQm5AjFIeA3ZyanjkIVbUTCzcaoz549EaxJwAGeOlbepzs'
const RP_WEBHOOK = 'https://discord.com/api/webhooks/1490563112141590630/40rj-bEEalfTwv6tbeCfoKoE2aUHRVrPDk2nYdj4kbupkQVKvCGmihELAc8Kj8P_4Bq0'

const CUTOFF_FB = '2026-05-10T06:50:00Z'  // 上次 feedback 處理到 backend-probe（06:46）
const CUTOFF_RP = '2026-05-10T15:10:00Z'  // 上次 report 處理到 藥師一階 109-2 #39（15:06）

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function postEmbed(url, embed) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  })
  if (resp.status === 429) {
    const j = await resp.json().catch(() => ({}))
    const retry = (j.retry_after || 5) * 1000
    console.log(`  429, wait ${retry}ms`)
    await sleep(retry + 500)
    return postEmbed(url, embed)
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => '')
    console.log(`  ${resp.status}:`, t.slice(0, 200))
    return false
  }
  return true
}

function fmtTime(iso) {
  return iso.slice(0, 19).replace('T', ' ')
}

async function main() {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

  // Feedback
  const { data: fbs, error: e1 } = await sb.from('feedback').select('*')
    .gt('created_at', CUTOFF_FB).order('created_at', { ascending: true })
  if (e1) throw e1
  console.log(`\n=== Feedback (${fbs.length} 筆, 自 ${CUTOFF_FB} 起) ===`)
  let fbSent = 0, fbSkip = 0
  for (const r of fbs) {
    // 跳過自己今天的測試
    const name = r.name || '匿名'
    if (/claude|webhook|probe|sanity/i.test(name) || /test|probe|fallback/i.test(r.message || '')) {
      console.log(`  跳過: ${fmtTime(r.created_at)} ${name} | ${(r.message||'').slice(0,30)}`)
      fbSkip++; continue
    }
    const embed = {
      title: '📩 新用戶回饋（補傳）',
      color: 0x3b82f6,
      fields: [
        { name: '來自', value: name, inline: true },
        { name: '時間', value: fmtTime(r.created_at), inline: true },
        ...(r.user_id ? [{ name: 'user_id', value: '`' + r.user_id + '`' }] : []),
        { name: '內容', value: (r.message || '').slice(0, 1024) },
      ],
    }
    const ok = await postEmbed(FB_WEBHOOK, embed)
    if (ok) { fbSent++; console.log(`  ✓ ${fmtTime(r.created_at)} ${name}`) }
    await sleep(1200)
  }

  // Reports
  const { data: rps, error: e2 } = await sb.from('reports').select('*')
    .gt('created_at', CUTOFF_RP).order('created_at', { ascending: true })
  if (e2) throw e2
  console.log(`\n=== Reports (${rps.length} 筆, 自 ${CUTOFF_RP} 起) ===`)
  let rpSent = 0, rpSkip = 0
  for (const r of rps) {
    const name = r.name || '匿名'
    if (/claude|webhook|probe|^AAO$/i.test(name) && (!r.message || r.message.length < 3)) {
      console.log(`  跳過空: ${fmtTime(r.created_at)} ${name}`)
      rpSkip++; continue
    }
    const locator = [
      r.roc_year ? `${r.roc_year}年${r.session || ''}` : '',
      r.number ? `第${r.number}題` : '',
    ].filter(Boolean).join(' ') || '未知'
    const fields = [
      { name: '來自', value: name, inline: true },
      { name: '時間', value: fmtTime(r.created_at), inline: true },
      { name: '定位', value: locator },
      { name: '題目 ID', value: r.question_id || '未知', inline: true },
      ...(r.user_id ? [{ name: 'user_id', value: '`' + r.user_id + '`', inline: true }] : []),
    ]
    if (r.question_text) fields.push({ name: '題目內容', value: r.question_text.slice(0, 200) })
    if (r.message) fields.push({ name: '使用者描述', value: r.message.slice(0, 1024) })
    const embed = { title: '⚠️ 題目錯誤回報（補傳）', color: 0xef4444, fields }
    const ok = await postEmbed(RP_WEBHOOK, embed)
    if (ok) { rpSent++; console.log(`  ✓ ${fmtTime(r.created_at)} ${name} | ${locator}`) }
    await sleep(1200)
  }

  console.log(`\n=== 完成 ===`)
  console.log(`Feedback: 送 ${fbSent} / 跳過 ${fbSkip}`)
  console.log(`Reports : 送 ${rpSent} / 跳過 ${rpSkip}`)
}

main().catch(e => { console.error(e); process.exit(1) })
