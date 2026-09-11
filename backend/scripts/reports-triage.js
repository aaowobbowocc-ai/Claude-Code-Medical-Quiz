#!/usr/bin/env node
/**
 * 題目回報分流工具（搭配 migrations/020_reports_status.sql）。
 *
 *   node scripts/reports-triage.js                       列出待處理
 *   node scripts/reports-triage.js --all                 列出全部（含已處理）
 *   node scripts/reports-triage.js --id <id> --status fixed --note "已修下標錯位" [--commit <sha>]
 *
 * status: pending | fixed | invalid | wontfix | blocked
 */

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
  const i = line.indexOf('=');
  if (i > 0 && !line.trim().startsWith('#')) process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
});

const supabase = require('../supabase');
const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

const VALID = ['pending', 'fixed', 'invalid', 'wontfix', 'blocked'];

async function list(all) {
  let q = supabase.from('reports')
    .select('id,created_at,question_id,roc_year,session,number,message,name,status,resolution')
    .order('created_at', { ascending: false })
    .limit(60);
  if (!all) q = q.eq('status', 'pending');
  const { data, error } = await q;
  if (error) {
    if (/status/i.test(error.message)) {
      console.error('❌ reports 還沒有 status 欄位 — 先到 Supabase SQL Editor 跑 migrations/020_reports_status.sql');
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  if (!data.length) { console.log(all ? '(沒有任何回報)' : '✅ 沒有待處理的回報'); return; }
  console.log(`\n=== ${all ? '全部' : '待處理'} 回報（${data.length} 筆）===\n`);
  for (const r of data) {
    const where = `${r.roc_year || '?'}${r.session || ''} #${r.number || '?'}`;
    console.log(`[${r.status || 'pending'}] ${String(r.created_at).slice(0, 16)}  ${r.question_id}  ${where}`);
    console.log(`   回報(${r.name || '匿名'}): ${String(r.message || '(未填)').replace(/\n/g, ' ').slice(0, 100)}`);
    if (r.resolution) console.log(`   結論: ${r.resolution}`);
    console.log(`   id: ${r.id}`);
  }
  console.log();
}

async function mark(id, status, note, sha) {
  if (!VALID.includes(status)) { console.error('status 必須是:', VALID.join(' | ')); process.exit(1); }
  const patch = { status, resolution: note || null, resolved_at: status === 'pending' ? null : new Date().toISOString() };
  if (sha) patch.commit_sha = sha;
  const { error } = await supabase.from('reports').update(patch).eq('id', id);
  if (error) { console.error('❌', error.message); process.exit(1); }
  console.log(`✅ ${id} → ${status}${note ? ' (' + note + ')' : ''}`);
}

(async () => {
  const id = arg('--id');
  if (id) await mark(id, arg('--status') || 'fixed', arg('--note'), arg('--commit'));
  else await list(args.includes('--all'));
})().catch(e => { console.error(e); process.exit(1); });
