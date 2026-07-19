require('dotenv').config();const{createClient}=require('@supabase/supabase-js')
;(async()=>{const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_KEY)
const{data:rps}=await sb.from('reports').select('*').gt('created_at',process.argv[2]||'2026-07-16T16:00:00Z').order('created_at',{ascending:true})
const{data:fbs}=await sb.from('feedback').select('*').gt('created_at',process.argv[2]||'2026-07-16T16:00:00Z').order('created_at',{ascending:true})
console.log('FB('+(fbs?.length||0)+')');for(const r of(fbs||[])){if(/claude|probe/i.test(r.name||''))continue;console.log('  '+r.created_at?.slice(5,16)+' '+(r.name||'?')+': '+(r.message||'').replace(/\n/g,' ').slice(0,90))}
console.log('RP('+(rps?.length||0)+')');for(const r of(rps||[])){const loc=[r.roc_year?r.roc_year+(r.session||''):'',r.number?'#'+r.number:''].filter(Boolean).join(' ');console.log('  '+r.created_at?.slice(5,16)+' '+(r.name||'?')+' id='+(r.question_id||'?')+' '+loc+' | '+(r.message||'').replace(/\n/g,' ').slice(0,80))}
})().catch(e=>{console.error(e.message);process.exit(1)})
