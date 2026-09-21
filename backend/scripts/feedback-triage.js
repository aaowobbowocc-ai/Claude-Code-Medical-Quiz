#!/usr/bin/env node
/**
 * 使用者回饋分流（搭配 migrations/021_feedback_status.sql）。
 *
 *   node scripts/feedback-triage.js                     列出未處理
 *   node scripts/feedback-triage.js --all               列出全部
 *   node scripts/feedback-triage.js --id 113 --status done --note "已查證" [--commit <sha>]
 *   node scripts/feedback-triage.js --before 2026-09-11 --status done --note "..."   批次標記
 *
 * status: new | done | planned | declined | duplicate | invalid
 */
const fs = require('fs');
const path = require('path');
fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf-8').split('\n').forEach(l => {
  const i = l.indexOf('='); if (i > 0 && !l.trim().startsWith('#')) process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
});
const supabase = require('../supabase');
const args = process.argv.slice(2);
const arg = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
const VALID = ['new', 'done', 'planned', 'declined', 'duplicate', 'invalid'];

async function list(all) {
  let q = supabase.from('feedback')
    .select('id,created_at,name,message,status,resolution')
    .order('created_at', { ascending: false }).limit(200);
  if (!all) q = q.eq('status', 'new');
  const { data, error } = await q;
  if (error) {
    if (/status/i.test(error.message)) {
      console.error('❌ feedback 還沒有 status 欄位 — 先到 Supabase SQL Editor 跑 migrations/021_feedback_status.sql');
      process.exitCode = 1; return;
    }
    throw error;
  }
  if (!data.length) { console.log(all ? '(沒有任何回饋)' : '✅ 沒有未處理的回饋'); return; }
  console.log(`\n=== ${all ? '全部' : '未處理'} 回饋（${data.length} 筆）===\n`);
  for (const f of data) {
    console.log(`[${f.status || 'new'}] ${String(f.created_at).slice(0, 10)}  ${f.name || '匿名'}  (id: ${f.id})`);
    console.log(`   ${String(f.message || '').replace(/\s+/g, ' ').slice(0, 150)}`);
    if (f.resolution) console.log(`   結論: ${f.resolution}`);
  }
  console.log();
}

async function mark(ids, status, note, sha) {
  if (!VALID.includes(status)) { console.error('status 必須是:', VALID.join(' | ')); process.exit(1); }
  const patch = { status, resolution: note || null, resolved_at: status === 'new' ? null : new Date().toISOString() };
  if (sha) patch.commit_sha = sha;
  const { data, error } = await supabase.from('feedback').update(patch).in('id', ids).select('id');
  if (error) { console.error('❌', error.message); process.exit(1); }
  console.log(`✅ ${data.length} 筆 → ${status}${note ? ' (' + note + ')' : ''}`);
}

(async () => {
  const id = arg('id'), status = arg('status'), before = arg('before');
  if (before && status) {
    const { data, error } = await supabase.from('feedback').select('id').lt('created_at', before).eq('status', 'new');
    if (error) { console.error('❌', error.message); process.exit(1); }
    if (!data.length) { console.log('沒有符合條件的回饋'); return; }
    await mark(data.map(f => f.id), status, arg('note'), arg('commit'));
  } else if (id && status) {
    await mark([id], status, arg('note'), arg('commit'));
  } else {
    await list(args.includes('--all'));
  }
})().catch(e => { console.error(e.stack); process.exit(1); });
