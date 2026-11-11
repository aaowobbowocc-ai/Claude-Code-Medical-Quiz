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
const { paperQuestions }=require(path.join(__dirname,'fill-civil-gaps'));
const { skeleton }=require(path.join(__dirname,'..','scripts','lib','moex-normalize'));

const fsx=require('fs');
/*
 * 第二種截斷：**開頭**被切掉，不是結尾。
 *   audiologist 104100 #2 「）會隨著時間而減少。此過程稱之為何？」
 *   audiologist 104100 #30「/s）對ABR的影響，下列敘述何者最正確？」
 *   dental1 115020 #23   「在一顆被拔下來的牙齒上面發現有3 個 system)最可能是下列那一顆牙齒?」
 * 上面那條簽章（短、以英數結尾、沒有句尾標點）抓不到這種 —— 它們不短，
 * 而且結尾好好的。
 *
 * 簽章用結構：**出現右括號，但前面沒有對應的左括號**。正常題幹不會這樣。
 * 長度與中文比例都試過，都不行：
 *   「≤40 字且沒有問句詞」→ 6,861 筆，絕大多數是正常的「…被稱為:」
 *     （中文題幹本來就常以冒號結尾）
 *   「中文字比例 <25%」  → 把「有關於 Electrocochleography(ECochG),
 *     下列何者錯誤?」這種正常的醫學題也掃進來
 * 用括號配對，全站只有 36 筆。
 */
function unbalancedParen(t){
 let d=0;
 for(const c of String(t)){
  if('（('.includes(c))d++;
  else if('）)'.includes(c)){ if(d===0)return true; d--; }
 }
 return false;
}

// 全站掃「題幹被截斷」的題（頭尾兩種），不再逐筆列 id
const TARGETS=[];
for(const f of fsx.readdirSync(path.join(__dirname,'..')).filter(x=>/^questions(-[a-z0-9-]*)?\.json$/.test(x))){
 const j=JSON.parse(fsx.readFileSync(path.join(__dirname,'..',f),'utf8'));
 const a=Array.isArray(j)?j:j.questions; if(!a)continue;
 const exam=f.replace('questions-','').replace('questions.json','doctor1').replace('.json','');
 for(const q of a){
  const t=String(q.question||'').trim();
  if(q&&q.incomplete)continue;
  const tailCut=t.length<45&&/[0-9A-Za-z]$/.test(t)&&!/[？?。：:]$/.test(t);
  const headCut=unbalancedParen(t);
  // 第三種：**中文字結尾**的截斷。tailCut 只認英數結尾，所以
  //   「下列為四種陶瓷-金屬界面可能的破」「下列何種免疫組織化學染色標記,可」
  //   「有關脊髓損傷患者呼吸功能的問題與處置方式」（使用者 2026-11-11 回報）
  // 一題都抓不到，而且它們常常超過 45 字，長度那關也擋掉。
  // 改用語意訊號：**提問句式開頭、整句卻連一個問號或冒號都沒有**。
  // 只看「結尾沒有標點」會撈到 5,830 筆，絕大多數是組合題
  //   （「…下列何種組合正確?①耳蝸基底部較狹小,故較rigid,」問號在中間），
  // 所以條件是整句都沒有，不是只看結尾。收斂到 156 筆。
  // 駕照排除（題幹本來就是句子開頭、由選項接完），學測／分科排除（不是考選部卷）。
  const askLead=/^(有關|關於|下列|以下|針對)/.test(t);
  const noAsk=askLead&&!/[？?：:﹖]/.test(t)&&!/[。．！!]$/.test(t)
    &&!['driver-car','driver-moto','gsat','ast'].includes(exam);
  if(tailCut||headCut||noAsk)TARGETS.push([f,exam,String(q.id)]);
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
    // spaced：fill-civil-gaps 的 paperQuestions 在接 run 時會依**間隙寬度**補空白
    //   （見 appendRun：英數之間 >2px 補一個空白、換行處前後都是英數才補）。
    //   pdfQuestions 沒有這一層，所以它吐出來的是「overactivebladder」「rootdepression」
    //   這種黏在一起的英文 —— 拿去補題幹等於把一種壞法換成另一種。
    //   題號與選項的配對仍然用 pdfQuestions（它的防呆與排序邏輯在下面用著），
    //   只有**題幹文字**改取 spaced 的版本，而且要 skeleton 相同才敢用。
    cache[key]=p?{qs:await pdfQuestions(await fetchSheet('Q',q.exam_code,p.c,p.s)),
                  txt:flat(await pdfText(await fetchSheet('Q',q.exam_code,p.c,p.s))),
                  spaced:await (async()=>{try{return await paperQuestions(q.exam_code,p.c,p.s)}catch{return null}})()}:null;
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
  // 開頭被截斷的題，前 12 字正好是壞掉的那一段（「）會隨著時間」），
  // 拿它去比一定對不上。先把開頭殘餘的標點／斜線剝掉再取樣。
  const core=skeleton(String(q.question).replace(/^[\s）)\/、，,。．:：；;]+/,''));
  const head=(core.length>=8?core:ours).slice(0,Math.min(12,Math.max(core.length,ours.length)));
  if(!theirs.startsWith(head)&&!theirs.includes(head)){
   console.log('✗',f,id,'#'+q.number,'原卷該題號是不同的題,拒絕寫入');
   console.log('     我們:',String(q.question).replace(/\s+/g,' ').slice(0,50));
   console.log('     原卷:',src.stem.replace(/\s+/g,' ').slice(0,50));
   continue;
  }
  /*
   * 原卷的題幹有時候比我們的還糟。run 幾何重疊會解出疊字 ——
   * speech-therapist 115100 #13 原卷解成「依序**序**為下列何者？」
   * 「thyroarytenoid **muuscle**」，寫進去就是把好題幹改壞
   * （成因見 lib/moex-run-overlap.js）。
   *
   * 守衛：**新題幹必須完整包含舊題幹的內容**。
   *   結尾被截的 → 舊的是新的前綴，成立
   *   開頭被截的 → 先把開頭的殘餘標點剝掉再比
   *   疊字壞掉的 → 包不住，擋下
   */
  /*
   * 題幹根本沒被截斷就不要動。
   * 上面那條簽章（短、以英數結尾、沒有句尾標點）誤判率很高：
   * 「下列那些抗體可以活化補體？ ①IgG ②IgD ③IgE ④IgA ⑤IgM」
   * 本來就以選項清單結尾，完全正常。這種題原卷解回來與現有逐字相同，
   * 真正會被換掉的只有選項 —— 那些選項沒壞，很多還是人工核對過的，
   * 重寫一遍只有風險沒有好處。這支腳本的職責是修截斷，不是重刷選項。
   */
  if(theirs===ours){console.log('✗',f,id,'#'+q.number,'題幹沒有被截斷（原卷與現有逐字相同）');continue;}
  if(core.length>=8&&!theirs.includes(core)){
   console.log('✗',f,id,'#'+q.number,'原卷題幹沒有完整包含我們的內容（可能原卷解出疊字），拒絕寫入');
   console.log('     我們:',String(q.question).replace(/\s+/g,' ').slice(0,56));
   console.log('     原卷:',src.stem.replace(/\s+/g,' ').slice(0,56));
   continue;
  }
  /*
   * 上面那條「新的要包含舊的」守衛只看得到舊題幹那一段，**補回來的尾巴沒人驗**。
   * 2026-11-11 實測 31 筆候選裡有 10 筆的尾巴自己就是壞的：
   *   疊字（run 幾何重疊）：「下列有關carvedilol 之敘述，何者錯誤**誤**？」
   *                        「下列何者不是多切面螺旋式CT 之優點**點**？」
   *   英文黏在一起（換行處沒補空白）：「overactive**bladde**」「acute**coronar**」
   *                        「occlusocervical**dimen**」「Aggregatibacter**actinomycet**」
   * 寫進去等於拿一個壞法換另一個壞法。這兩種都只出現在新增的那一段，所以只驗尾巴。
   * 判準刻意保守：中文字「立刻重複一次」在正常題幹幾乎不出現（「一一」「個個」
   * 這類疊詞不會緊接在句尾標點前），英文連續 18 個字母以上則一定是黏起來的。
   */
  // ❗ 疊字常常**跨在接縫上**（舊題幹收尾「錯誤」、補回來的是「誤？」），
  //    只看 added 會漏，要往前多拿一個字。
  // ⚠️ 比對**一定要用原字串**，不能用 theirs/ours —— 那兩個是 skeleton()，
  //    空白全被刪掉了，拿來看「英文有沒有黏在一起」會每一筆都中。
  const rawOld=String(q.question), rawNew=String(src.stem)
  const dupCJK=/([一-鿿])\1/.test(rawNew) && !/([一-鿿])\1/.test(rawOld)
  // 16 個以上的連續英文字母：真正的單字到這個長度已經很少
  //   （immunohistochemical 是 19，所以有誤擋；但誤擋只是少修一題，
  //    寫進去則是把題幹弄壞，寧可偏安全那邊）。
  // 「16 個字母」還是擋不住**兩個短字黏在一起**：rootdepression(14)、acutecoronary(13)、
  // forClubhouse(12)、overactivebladder(17 擋得到但 occlusocervicaldimension 這種才是多數)。
  // 成因是 pdfQuestions 在換行處沒補空白（見 reference_moex_parser_variants 第 7 條：
  // 前後都是英數才補空白，中文不能補），而這支腳本拿的是它的輸出。
  // 在那之前，**補回來的那一段只要多出英文字母就一律不寫** ——
  // 純中文的尾巴（「，下列敘述何者錯誤？」）沒有這個問題，那些照修。
  // 改抓 spaced 版的題幹。兩邊 skeleton 必須完全相同 —— 相同就表示
  // 「字一個不差，只差空白」，那正是我們要的；不同就是兩支解析器看法不一致，不冒險。
  const sp=pc.spaced && pc.spaced.get(+q.number)
  const spacedStem=(sp && skeleton(sp.stem)===theirs) ? sp.stem : null
  if(!spacedStem){
   console.log('✗',f,id,'#'+q.number,'拿不到保留空白的題幹（'+(sp?'兩支解析器的題幹不一致':'spaced 解析不出這題')+'），拒絕寫入');
   continue;
  }
  const latin=t=>(String(t).match(/[A-Za-z]/g)||[]).length
  const glued=latin(spacedStem)>latin(rawOld)&&/[A-Za-z]{16,}/.test(spacedStem)&&!/[A-Za-z]{16,}/.test(rawOld)
  if(dupCJK||glued){
   console.log('✗',f,id,'#'+q.number,'補回來的那一段本身是壞的（'+(dupCJK?'疊字':'')+(dupCJK&&glued?'＋':'')+(glued?'英文黏在一起':'')+'），拒絕寫入');
   console.log('     補回:',src.stem.replace(/\s+/g,' ').slice(Math.max(0,String(q.question).length-6),String(q.question).length+40));
   continue;
  }
  console.log('✓',f.replace('questions-','').replace('.json',''),q.exam_code,'#'+q.number);
  console.log('   舊題幹:',String(q.question).replace(/\s+/g,' ').slice(0,70));
  console.log('   新題幹:',spacedStem.replace(/\s+/g,' ').slice(0,70));
  console.log('   新選項:',opts.map(o=>String(o).replace(/\s+/g,' ').slice(0,26)).join(' | '));
  if(APPLY){
   // 寫入時做 NFC：原卷夾帶康熙部首/相容表意文字，直接寫進去會讓搜尋與比對靜默失效
   const nfc=t=>String(t).normalize('NFC').replace(/[⼀-⿟]/g,c=>String.fromCodePoint(c.codePointAt(0)-0x2F00+0x4E00>0?c.normalize('NFKC').codePointAt(0):c.codePointAt(0)));
   q.question=nfc(spacedStem);
   q.options={A:nfc(opts[0]),B:nfc(opts[1]),C:nfc(opts[2]),D:nfc(opts[3])};
   if(q.incomplete&&/broken_options|truncated/.test(q.incomplete))delete q.incomplete;
   touched.add(f);
  }
  ok++;
 }
 if(APPLY)touched.forEach(f=>fs.writeFileSync(path.join(__dirname,'..',f),JSON.stringify(banks[f].j,null,2),'utf8'));
 console.log((APPLY?'已修 ':'可修 ')+ok+'/'+TARGETS.length);
})().catch(e=>console.error(e.stack));
