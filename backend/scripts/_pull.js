require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')
const CUTOFF = process.argv[2] || '2026-07-15T14:00:00Z'
;(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  const { data: fbs } = await sb.from('feedback').select('*').gt('created_at', CUTOFF).order('created_at', { ascending: true })
  const { data: rps } = await sb.from('reports').select('*').gt('created_at', CUTOFF).order('created_at', { ascending: true })
  console.log(`FEEDBACK (${fbs?.length||0})`)
  for (const r of (fbs||[])) { if (/claude|webhook|probe/i.test(r.name||'')) continue; console.log(`[FB] ${r.created_at?.slice(0,16)} | ${r.name||'匿名'} | ${(r.message||'').replace(/\n/g,' ').slice(0,150)}`) }
  console.log(`\nREPORTS (${rps?.length||0})`)
  for (const r of (rps||[])) { const loc=[r.roc_year?`${r.roc_year}${r.session||''}`:'',r.number?`#${r.number}`:''].filter(Boolean).join(' '); console.log(`[RP] ${r.created_at?.slice(0,16)} | ${r.name||'匿名'} | id=${r.question_id||'?'} | ${loc} | ${(r.message||'').replace(/\n/g,' ').slice(0,120)}`) }
})().catch(e => { console.error(e.message); process.exit(1) })
