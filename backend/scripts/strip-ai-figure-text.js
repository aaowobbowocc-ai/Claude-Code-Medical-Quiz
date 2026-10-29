#!/usr/bin/env node
/**
 * 砍掉題幹裡「AI 幫圖寫的文字描述」—— 學測／分科。
 *
 * 違反的是一條明確的使用者要求：**含圖題不要文字化、不加標註，
 * 題幹 100% 等同考選部／大考中心原卷**。但題庫裡有幾題長這樣：
 *
 *   官方：圖4為颱風由臺灣東部往西偏北移動之示意圖。當颱風中心正由西海岸
 *         中部的乙點附近出海時，回答15-16題。
 *   我們：…回答15-16題。**圖4顯示台灣地圖，颱風路徑由東部向西北移動，颱風眼
 *         位於西海岸中部的乙點附近。圖中標示了甲、乙、丙、丁、戊五處海岸點
 *         以及最大暴風半徑。** 甲、乙、丙、丁、戊五處海岸，何處最容易…
 *
 * 加粗那段原卷上完全沒有。有真圖的題旁邊還會多這一段，更像錯字。
 *
 * **判準是「這段文字不在原卷上」，不是靠語氣猜哪句是 AI 寫的。** 三個條件
 * 全部成立才動：
 *   1. 候選段落去掉空白後，在原卷文字裡**找不到**；
 *   2. 砍掉之後，前半段與後半段在原卷裡**仍然相鄰**（中間最多隔 8 個字，
 *      留給「15.」這種題號）；
 *   3. 候選段落至少 10 個字（避免切到標點）。
 * 任一條不成立就原封不動列出來，不猜。
 *
 *   node scripts/strip-ai-figure-text.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const pdfParse = require('pdf-parse');
const { REGISTRY, BASE } = require('./scrape-ceec');
const { toHalfWidth } = require('./lib/moex-normalize');

const BK = path.join(__dirname, '..');
const CACHE = path.join(BK, '_tmp', 'ceec-pdf');
const APPLY = process.argv.includes('--apply');
/** AI 描述的開頭。注意這個簽章會抓到原卷本來就有的句子
 *  （「圖 2 顯示 1960 年後，雙方貿易出現重大變化，關鍵因素為何？」是官方原文），
 *  所以只能當「候選」用，真正的判定在上面那三個條件。 */
const START = /圖\s*[0-9０-９一二三四五六七八九十]{1,3}\s*顯示|圖中顯示|圖片顯示|此圖顯示/;
/** 題庫的中文科目名 → REGISTRY 的 tag。跟 extract-ceec-figures.js 同一張表。 */
const TAG = { 國文: 'zh', 英文: 'en', 社會: 'social', 自然: 'science', 數學: 'math', 數學A: 'mathA', 數學B: 'mathB', 物理: 'physics', 化學: 'chemistry', 生物: 'biology', 地球科學: 'earth', 歷史: 'history', 地理: 'geography', 公民與社會: 'civics' };

/**
 * 比對用的正規化。去空白**不夠** —— 我們存的題幹用半形「,」「?」，
 * 大考中心原卷印的是全形「，」「？」，只去空白的話每一題都會被判成
 * 「這段不在原卷上」，於是整個題幹被當成 AI 寫的砍掉
 * （試跑時 gsat_100 社會 #6 差一步就整句消失）。
 * 全形半形一律折成同一種，再比。
 */
// ○（空心圓）在大考中心 PDF 的文字層會被印成「。」
// （gsat_100 自然「「○」代表核外電子」實測），所以比對時把兩者視為同一個。
// 折疊只影響比對、不改存進題庫的文字；而且放寬比對只會讓「這段是原卷本來就有的」
// 更容易成立，也就是更少動刀，方向是安全的。
const FOLD = [[/[，、]/g, ','], [/[。．○〇]/g, '.'], [/[？]/g, '?'], [/[！]/g, '!'],
  [/[：]/g, ':'], [/[；]/g, ';'], [/[（]/g, '('], [/[）]/g, ')'],
  [/[「」『』“”"']/g, ''], [/[－—–‐]/g, '-'], [/[～]/g, '~']];
function nospace(t) {
  let x = toHalfWidth(String(t || '')).normalize('NFC').replace(/\s/g, '');
  for (const [re, to] of FOLD) x = x.replace(re, to);
  return x;
}

function download(url, r = 0) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, x => {
      if ([301, 302, 303, 307, 308].includes(x.statusCode) && r < 5)
        return res(download(new URL(x.headers.location, url).href, r + 1));
      const b = []; x.on('data', d => b.push(d)).on('end', () => res(Buffer.concat(b)));
    }).on('error', rej);
  });
}

async function officialText(exam, year, tag) {
  const entry = REGISTRY[exam] && REGISTRY[exam].years[year] && REGISTRY[exam].years[year][tag];
  if (!entry || !entry.q) return null;
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, `${exam}_${year}_${tag}.pdf`);
  let buf;
  if (fs.existsSync(f) && fs.statSync(f).size > 10000) buf = fs.readFileSync(f);
  else { buf = await download(BASE + entry.q); fs.writeFileSync(f, buf); }
  const { text } = await pdfParse(buf);
  return nospace(text);
}

/**
 * 找出「砍掉之後前後仍相鄰」的那一段。從最短的候選開始試，
 * 第一個滿足三條件的就回傳 —— 砍最少，不貪心。
 */
function findBlock(stem, OT) {
  const m = START.exec(stem);
  if (!m) return null;
  const s = m.index;
  const pre = nospace(stem.slice(0, s));
  // 錨點長度要彈性。原卷的 PDF 文字層會把個別字元印壞
  // （gsat_100 自然「「○」代表核外電子」的 ○ 在文字層是「。」），
  // 固定 14 字的錨點只要壓到那個字就永遠對不上，整題被誤判成「題幹不對」。
  // 從長往短試，夠長（>= 8 字）就算對上。
  let anchor = '', i = -1;
  if (!pre) { anchor = ''; i = 0; }
  else for (let k = Math.min(16, pre.length); k >= 8; k--) {
    const cand = pre.slice(-k);
    const at = OT.indexOf(cand);
    if (at >= 0) { anchor = cand; i = at; break; }
  }
  if (pre && i < 0) return { why: '前半段在原卷裡找不到（可能整題題幹都不對）' };

  // 候選結尾：開頭之後的每一個句末標點
  const ends = [];
  for (let k = s; k < stem.length; k++) if ('。？？!！'.includes(stem[k])) ends.push(k + 1);
  ends.push(stem.length);                       // 描述在題幹最後面的情形（#24）

  for (const e of ends) {
    const block = stem.slice(s, e);
    if (nospace(block).length < 10) continue;
    // 圖說描述不會問問題。候選段落一旦含問句標記，就表示切點跑過頭、
    // 把真正的題目也包進來了（試跑時 ast_114 地理 #18 正是如此）。
    if (/[？?]|下列|何者|為何|請問|試問|最可能/.test(block)) continue;
    if (OT.includes(nospace(block))) continue;  // 原卷本來就有這句 → 不是 AI 加的
    const rest = (stem.slice(0, s) + ' ' + stem.slice(e)).replace(/\s+/g, ' ').trim();
    // 防呆：絕不把整個題幹砍光，也不砍掉超過七成。
    // 試跑時 ast_114 地理 #18 的候選一路延伸到把真正的題目
    //（「根據題文，該帆船船隊…最可能依序航經哪些洋流」）也包進去。
    if (rest.length < 20) continue;
    if (nospace(block).length > nospace(stem).length * 0.7) continue;
    const suf = nospace(stem.slice(e)).slice(0, 14);
    if (!suf) return { block, rest };           // 描述在最後，沒有後半段要檢查
    const k = OT.indexOf(suf, Math.max(0, i));
    if (k < 0) continue;
    // 前半段結尾與後半段開頭在原卷裡要相鄰（中間容許「15.」這種題號）
    if (k - (i + anchor.length) > 8) continue;
    return { block, rest };
  }
  return { why: '找不到「砍掉後前後仍相鄰」的切點（可能原卷本來就這樣寫）' };
}

(async () => {
  const plan = [], kept = [];
  for (const exam of ['gsat', 'ast']) {
    const def = REGISTRY[exam];
    const file = path.join(BK, def.outputFile);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    const hit = arr.filter(q => q && START.test(String(q.question || '')));
    const groups = {};
    for (const q of hit) (groups[`${q.exam_code}|${q.subject}`] = groups[`${q.exam_code}|${q.subject}`] || []).push(q);

    let touched = false;
    for (const key of Object.keys(groups)) {
      const [code, subject] = key.split('|');
      const year = code.replace(/^.*_/, '');
      const tag = TAG[subject];
      let OT = null;
      try { OT = tag ? await officialText(exam, year, tag) : null; } catch (e) { /* 下面統一記 */ }
      if (!OT) { groups[key].forEach(q => kept.push({ exam, code, subject, n: q.number, why: `拿不到原卷文字（tag=${tag || '?'}）` })); continue; }
      const pending = [], okBlocks = new Set();
      for (const q of groups[key]) {
        const r = findBlock(String(q.question), OT);
        const row = { exam, code, subject, n: q.number, hasImg: !!(q.images || q.image) };
        if (!r || r.why) { pending.push({ q, row, why: (r && r.why) || '沒有候選段落' }); continue; }
        okBlocks.add(r.block.replace(/\s+/g, ' ').trim());
        plan.push({ ...row, block: r.block, rest: r.rest });
        if (APPLY) { q.question = r.rest; touched = true; }
      }
      // 第二輪：題組裡的每一題都帶同一份題組前言，所以「前言與這題的題目在
      // 原卷裡相鄰」只對題組的**第一題**成立 —— 中間還夾著前面幾題
      //（gsat_100 自然 #17 過了，#18/#19 同前言同描述卻被擋）。
      // 既然那段文字已經在同一張卷上驗證過「原卷沒有」，就可以直接套用，
      // 證據是同一份，不是重新猜。
      for (const { q, row, why } of pending) {
        const stem = String(q.question);
        const hitBlock = [...okBlocks].find(b => b && stem.includes(b));
        if (!hitBlock) { kept.push({ ...row, why }); continue; }
        const rest = stem.replace(hitBlock, ' ').replace(/\s+/g, ' ').trim();
        if (rest.length < 20) { kept.push({ ...row, why }); continue; }
        plan.push({ ...row, block: hitBlock, rest, via: '同卷已驗證過的同一段' });
        if (APPLY) { q.question = rest; touched = true; }
      }
    }
    if (APPLY && touched) fs.writeFileSync(file, JSON.stringify(j, null, 2), 'utf8');
  }

  console.log(`可移除 ${plan.length} 題的 AI 圖說，保留不動 ${kept.length} 題\n`);
  for (const r of plan) {
    console.log(`  ✂ ${r.exam} ${r.code} ${r.subject} #${r.n}${r.hasImg ? '【已有真圖】' : '【無圖】'}`);
    console.log(`      砍掉：${r.block.slice(0, 110)}${r.via ? '   ←' + r.via : ''}`);
    console.log(`      剩下：${r.rest.slice(0, 110)}`);
  }
  if (kept.length) {
    console.log('\n保留不動（判準沒過，就不猜）：');
    for (const r of kept) console.log(`  · ${r.exam} ${r.code} ${r.subject} #${r.n} — ${r.why}`);
  }
  console.log(APPLY ? '\n已寫入' : '\n(試跑；加 --apply 才寫入)');
})().catch(e => { console.error(e.stack); process.exit(1); });
