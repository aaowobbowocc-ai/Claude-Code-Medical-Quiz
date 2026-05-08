#!/usr/bin/env node
/**
 * Supabase 每日備份 — export 重要表為 JSON.gz 存檔。
 *
 * 原因：Supabase free tier 沒有自動 daily backup，誤刪/帳號被停=資料消失。
 * 此腳本可以本地跑、也可以排成 GitHub Actions cron job、或 fly.io machine cron。
 *
 * Usage:
 *   node scripts/backup-supabase.js                     # 預設輸出到 _backup/<日期>/
 *   node scripts/backup-supabase.js --out=/mnt/backup   # 自訂目錄
 *   node scripts/backup-supabase.js --tables=ai_explanations,profiles
 */
require('dotenv/config')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const supabase = require('../supabase')

const TABLES = [
  'ai_explanations',          // ~30K rows, biggest
  'rag_documents',            // ~7K rows
  'rag_chunks',               // ~33K rows
  'profiles',                 // 使用者資料
  'user_coin_grants',         // 金幣發放紀錄
  'user_explanation_unlocks', // 解鎖紀錄
  'comments',                 // 留言
  'community_notes',          // 社群筆記
  'leaderboard',              // 排行榜
  'site_stats',               // 統計快照
  'claimed_rewards',          // changelog rewards
  'coin_orders',              // 街口訂單（如已建表）
]

async function dumpTable(table, outDir) {
  const PAGE = 1000
  let from = 0, all = []
  while (true) {
    const { data, error } = await supabase.from(table).select('*').range(from, from + PAGE - 1)
    if (error) {
      // Table might not exist (e.g. coin_orders not migrated yet) — skip silently
      if (/relation .* does not exist|table .* not found/i.test(error.message || '')) {
        return { rows: 0, skipped: 'table not found' }
      }
      throw error
    }
    if (!data?.length) break
    all = all.concat(data)
    if (data.length < PAGE) break
    from += PAGE
  }
  const out = path.join(outDir, `${table}.json.gz`)
  const json = JSON.stringify(all)
  const gz = zlib.gzipSync(json, { level: 9 })
  fs.writeFileSync(out, gz)
  return { rows: all.length, bytes: gz.length }
}

async function main() {
  const args = process.argv.slice(2)
  const outBase = args.find(a => a.startsWith('--out='))?.split('=')[1] ||
                  path.join(__dirname, '..', '_backup')
  const tableFilter = args.find(a => a.startsWith('--tables='))?.split('=')[1]
  const targets = tableFilter ? tableFilter.split(',') : TABLES

  const today = new Date().toISOString().slice(0, 10)
  const outDir = path.join(outBase, today)
  fs.mkdirSync(outDir, { recursive: true })

  console.log(`[backup] target: ${outDir}`)
  console.log(`[backup] tables: ${targets.join(', ')}`)
  let totalRows = 0, totalBytes = 0
  const stats = []

  for (const t of targets) {
    process.stdout.write(`  ${t}... `)
    try {
      const r = await dumpTable(t, outDir)
      if (r.skipped) {
        console.log(`skipped (${r.skipped})`)
        stats.push({ table: t, status: 'skipped' })
      } else {
        console.log(`${r.rows} rows / ${(r.bytes / 1024).toFixed(0)} KB`)
        totalRows += r.rows
        totalBytes += r.bytes
        stats.push({ table: t, rows: r.rows, bytes: r.bytes })
      }
    } catch (e) {
      console.log(`FAILED: ${e.message}`)
      stats.push({ table: t, status: 'error', error: e.message })
    }
  }

  // Manifest
  const manifest = {
    timestamp: new Date().toISOString(),
    tables: stats,
    totalRows,
    totalBytes,
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  console.log(`\n=== DONE ===`)
  console.log(`  Tables:  ${stats.length}`)
  console.log(`  Rows:    ${totalRows.toLocaleString()}`)
  console.log(`  Size:    ${(totalBytes / 1024 / 1024).toFixed(1)} MB compressed`)
  console.log(`  Output:  ${outDir}`)

  // Cleanup old backups (keep last 30 days)
  try {
    const all = fs.readdirSync(outBase).filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f))
    if (all.length > 30) {
      const sorted = all.sort()
      const toDelete = sorted.slice(0, sorted.length - 30)
      for (const d of toDelete) {
        fs.rmSync(path.join(outBase, d), { recursive: true })
      }
      console.log(`  Cleaned ${toDelete.length} old backup(s) (>30d)`)
    }
  } catch {}
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
