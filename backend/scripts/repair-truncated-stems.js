#!/usr/bin/env node
/**
 * 全站掃描「題幹被截成只剩開頭」的題（短、且以英數結尾、沒有句尾標點），
 * 回考選部原卷取完整題幹與選項。考選部 PDF 把上下標壓平會造成這種截斷，
 * 例如「ADP P2Y receptor…12」其實是「ADP P2Y12 receptor」。
 *
 * 三道防呆：
 *   1. 選項順序一律用 pdfText 的閱讀順序重排——pdfQuestions 的順序不可信
 *      （雙欄版型會整組轉一格，見 reference_moex_shared_libs）
 *   2. 原卷該題號必須是同一題（用 NFKC skeleton 比前綴）。題號對不上的卷
 *      會取回完全不同的題，doctor1 106100 實測。
 *   3. 寫入前做 NFC——原卷夾帶康熙部首等相容字元，直接寫進去搜尋會靜默失效
 *
 *   node scripts/repair-truncated-stems.js [--apply]
 *
 * 前身 fix-truncated-stems.js 是硬寫 5 題的一次性腳本，保留未動。
 */
const fs=require('fs'),path=require('path');
const { resolvePaper, fetchSheet }=require(path.join(__dirname,'..','scripts','lib','moex-paper-resolve'));
const { pdfText, pdfQuestions }=require(path.join(__dirname,'..','scripts','lib','moex-pdf-parse'));
const { skeleton }=require(path.join(__dirname,'..','scripts','lib','moex-normalize'));

const fsx=require('fs');
// 全站掃「題幹被截成只剩開頭」的題，不再逐筆列 id
const TARGETS=[];
for(const f of fsx.readdirSync(path.join(__dirname,'..')).filter(x=>/^questions(-[a-z0-9-]*)?\.json$/.test(x))){
 const j=JSON.parse(fsx.readFileSync(path.join(__dirname,'..',f),'utf8'));
 const a=Array.isArray(j)?j:j.questions; if(!a)continue;
 const exam=f.replace('questions-','').replace('questions.json','doctor1').replace('.json','');
 for(const q of a){
  const t=String(q.question||'').trim();
  if(t.length<45&&/[0-9A-Za-z]$/.test(t)&&!/[？?。：:]$/.test(t))TARGETS.push([f,exam,String(q.id)]);
 }
}
console.log('掃到疑似截斷題幹', TARGETS.length, '題');
const APPLY=process.argv.includes('--apply');
const flat=s=>String(s).replace(/\s+/g,'');
const banks={},cache={};
(async()=>{
 const touched=new Set();let ok=0;
 for(const [f,exam,id] of TARGETS){
  if(!banks[f]){const j=JSON.parse(fs.readFileSync(path.join(__dirname,'..',f),'utf8'));banks[f]={j,a:Array.isArray(j)?j:j.questions};}
  const q=banks[f].a.find(x=>String(x.id)===String(id));
  if(!q){console.log('✗',f,id,'查無');continue;}
  const key=f+'|'+q.exam_code+'|'+q.subject;
  if(cache[key]===undefined){
   const items=banks[f].a.filter(x=>x.exam_code===q.exam_code&&x.subject===q.subject);
   try{
    const p=await resolvePaper({exam,code:q.exam_code,subject:q.subject,year:String(q.exam_code).slice(0,3),items});
    cache[key]=p?{qs:await pdfQuestions(await fetchSheet('Q',q.exam_code,p.c,p.s)),
                  txt:flat(await pdfText(await fetchSheet('Q',q.exam_code,p.c,p.s)))}:null;
   }catch(e){cache[key]=null;}
  }
  const pc=cache[key];
  if(!pc){console.log('✗',f,id,q.exam_code,q.subject,'對不到官方卷');continue;}
  const src=pc.qs.get(+q.number);
  if(!src){console.log('✗',f,id,'#'+q.number,'原卷解析不出');continue;}
  // 選項依原文閱讀順序重排
  const fstem=flat(src.stem);
  let si=-1;
  for(const pr of [fstem.slice(0,20),fstem.slice(0,14),fstem.slice(4,20),fstem.slice(0,10)]){
   if(pr.length<8)continue;si=pc.txt.indexOf(pr);if(si>=0)break;}
  if(si<0){console.log('✗',f,id,'#'+q.number,'原文定位不到題幹');continue;}
  const win=pc.txt.slice(si+fstem.length-4,si+fstem.length+src.options.reduce((n,o)=>n+flat(o).length,0)+60);
  if(src.options.some(o=>!flat(o))){console.log('✗',f,id,'有空選項');continue;}
  const occ=src.options.map(o=>{const t=flat(o),r=[];for(let i=win.indexOf(t);i>=0&&r.length<40;i=win.indexOf(t,i+1))r.push({i,len:t.length});return r;});
  if(occ.some(o=>!o.length)){console.log('✗',f,id,'選項在原文找不到');continue;}
  const perms=[];(function pm(c,r){if(!r.length){perms.push(c.slice());return;}for(let k=0;k<r.length;k++)pm(c.concat(r[k]),r.filter((_,m)=>m!==k));})([],[0,1,2,3]);
  const sols=[];
  for(const p2 of perms){let end=-1,good=true;for(const k of p2){const c2=occ[k].find(o=>o.i>=end);if(!c2){good=false;break;}end=c2.i+c2.len;}if(good)sols.push(p2);}
  if(sols.length!==1){console.log('✗',f,id,'選項順序解出'+sols.length+'種');continue;}
  const opts=sols[0].map(k=>src.options[k]);
  // 題號對不上的卷會取回完全不同的題（doctor1 106100 實測）。
  // 截斷修復的前提是「我們的題幹是原卷題幹的開頭」，不成立就拒絕。
  // 一定要用 skeleton（NFKC）比，考選部 PDF 夾帶康熙部首等相容字元
  // （離「子」U+5B50 vs 離「⼦」U+2F26 字形相同碼位不同）
  const ours=skeleton(q.question), theirs=skeleton(src.stem);
  const head=ours.slice(0,Math.min(12,ours.length));
  if(!theirs.startsWith(head)&&!theirs.includes(head)){
   console.log('✗',f,id,'#'+q.number,'原卷該題號是不同的題,拒絕寫入');
   console.log('     我們:',String(q.question).replace(/\s+/g,' ').slice(0,50));
   console.log('     原卷:',src.stem.replace(/\s+/g,' ').slice(0,50));
   continue;
  }
  console.log('✓',f.replace('questions-','').replace('.json',''),q.exam_code,'#'+q.number);
  console.log('   舊題幹:',String(q.question).replace(/\s+/g,' ').slice(0,70));
  console.log('   新題幹:',src.stem.replace(/\s+/g,' ').slice(0,70));
  console.log('   新選項:',opts.map(o=>String(o).replace(/\s+/g,' ').slice(0,26)).join(' | '));
  if(APPLY){
   // 寫入時做 NFC：原卷夾帶康熙部首/相容表意文字，直接寫進去會讓搜尋與比對靜默失效
   const nfc=t=>String(t).normalize('NFC').replace(/[⼀-⿟]/g,c=>String.fromCodePoint(c.codePointAt(0)-0x2F00+0x4E00>0?c.normalize('NFKC').codePointAt(0):c.codePointAt(0)));
   q.question=nfc(src.stem);
   q.options={A:nfc(opts[0]),B:nfc(opts[1]),C:nfc(opts[2]),D:nfc(opts[3])};
   if(q.incomplete&&/broken_options|truncated/.test(q.incomplete))delete q.incomplete;
   touched.add(f);
  }
  ok++;
 }
 if(APPLY)touched.forEach(f=>fs.writeFileSync(path.join(__dirname,'..',f),JSON.stringify(banks[f].j,null,2),'utf8'));
 console.log((APPLY?'已修 ':'可修 ')+ok+'/'+TARGETS.length);
})().catch(e=>console.error(e.stack));
