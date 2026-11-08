#!/usr/bin/env node
/**
 * 依考選部原卷的實際順序，把一張卷的題號改回正確值。
 *
 * 用在 audit-number-shift.js 標出來的「題號整段位移」卷。
 *
 * 2026-11-08 的案例：doctor1 106100 醫學(一)/(二)。
 * 成因是 `renumber-doctor1-101-106.js` —— 當年為了消除重複題號，
 * 把 101~106 的醫學(一)/(二) **依序重編成 1..N**。原卷若多一題或少一題，
 * 依序重編就會讓後面整段偏離官方題號：
 *   106100 醫學(一) 原號 #20 有兩筆 → 重編後 #21 與 #22 都來自原號 20，
 *   之後 82 題全部 +1。醫學(二) 同理 81 題。
 * 題幹與答案是**一起**移動的，所以答案相對題幹沒錯，壞的是題號
 * （以及接縫處冒出來的一對重複題，那是唯一露出水面的症狀）。
 *
 * 同一支腳本當年對 106020 反而是**對的** —— 那張卷的原號是兩份來源各自
 * 編 1..41，徹底壞掉，依序重編才救回來。所以不要整批還原 _original_number。
 *
 * **判準用兩個互相獨立的方法，必須一致才寫入：**
 *   1. 排名法：題幹在原卷扁平文字裡的位置排序，第 k 個就是第 k 題
 *   2. 數字法：題幹前面最近的那串數字（頁首會黏上來，取結尾）
 * 兩者不一致的題一律不動並列出來。
 *
 * 在原卷裡找不到題幹的，是**外來題**（不屬於這張卷），標 wrong_source_paper
 * 讓前端隱藏，不要改它的號碼，也不要刪。
 *
 *   node scripts/renumber-from-paper.js --exam doctor1 --code 106100 --subject "醫學(一)" [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { pdfText } = require('./lib/moex-pdf-parse');

const BK = path.join(BK_DIR());
function BK_DIR() { return path.join(__dirname, '..'); }
const arg = k => {
  const eq = process.argv.find(a => a.startsWith(`--${k}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : null;
};
const APPLY = process.argv.includes('--apply');
const EXAM = arg('exam'), CODE = arg('code'), SUBJECT = arg('subject');
if (!EXAM || !CODE || !SUBJECT) { console.error('需要 --exam --code --subject'); process.exit(1); }
const FILE = e => e === 'doctor1' ? 'questions.json' : `questions-${e}.json`;
const flat = s => String(s).replace(/\s+/g, '');

(async () => {
  const p0 = path.join(BK, FILE(EXAM));
  const j = JSON.parse(fs.readFileSync(p0, 'utf8'));
  const arr = Array.isArray(j) ? j : j.questions;
  const items = arr.filter(q => q && String(q.exam_code) === CODE && q.subject === SUBJECT)
    .sort((a, b) => a.number - b.number);
  if (!items.length) { console.error('找不到這張卷'); process.exit(1); }

  const p = await resolvePaper({ exam: EXAM, code: CODE, subject: SUBJECT, year: String(CODE).slice(0, 3), items });
  if (!p) { console.error('對不到官方卷'); process.exit(1); }
  const txt = flat(await pdfText(await fetchSheet('Q', CODE, p.c, p.s)));
  console.log(`本地 ${items.length} 題｜官方卷 c=${p.c} s=${p.s} hitRate=${p.hitRate}`);

  // 定位每一題在原卷扁平文字裡的位置
  const located = [], strays = [], ambiguous = [];
  for (const q of items) {
    // 題幹太短（「下列何者正確？」）定位不準，接第一個選項補足長度再找
    let probe = flat(q.question).slice(0, 24);
    if (probe.length < 12) probe = (flat(q.question) + flat((q.options || {}).A)).slice(0, 24);
    if (probe.length < 12) { ambiguous.push({ q, why: '題幹與選項都太短，無法定位' }); continue; }
    const first = txt.indexOf(probe);
    if (first < 0) { strays.push(q); continue; }
    if (txt.indexOf(probe, first + 1) >= 0) { ambiguous.push({ q, why: '題幹在原卷出現多次' }); continue; }
    located.push({ q, at: first });
  }
  located.sort((a, b) => a.at - b.at);

  /*
   * 題號取「題幹前面最近的那串數字」。兩個坑：
   *   - 頁首會黏上來（「頁次：6－3」→「…63」），所以只看結尾。
   *   - 不能用「第幾個定位到的就是第幾題」當主判準：原卷有而我們缺的題
   *     會讓排名整段偏掉（醫學(一) 官方 100 題、我們只定位到 99 題，
   *     排名法於是比數字法整整少 1，65/99 不一致）。
   * 所以主判準是數字，一致性檢查改用「沿文件順序必須遞增」：
   * 期望值 = 前一個接受的號碼 + 1，允許跳號（我們缺題時），不允許回頭或亂跳。
   */
  let prev = 0;
  for (const r of located) {
    const m = txt.slice(Math.max(0, r.at - 14), r.at).match(/(\d{1,3})[.．、]?$/);
    r.raw = m ? m[1] : null;
    r.num = null;
    if (!r.raw) continue;
    // 從 prev+1 往後找最多 3 個候選，取第一個「raw 以它結尾」的
    for (let cand = prev + 1; cand <= prev + 3; cand++) {
      if (r.raw.endsWith(String(cand))) { r.num = cand; prev = cand; break; }
    }
  }

  const agree = located.filter(r => r.num !== null);
  const clash = located.filter(r => r.num === null);
  console.log(`定位成功 ${located.length}｜題號判定成功 ${agree.length}｜判不出 ${clash.length}｜外來題 ${strays.length}｜無法定位 ${ambiguous.length}`);
  /*
   * 判不出題號的，有一種是「它跟另一題一模一樣」—— 兩筆指向原卷同一個位置，
   * 先到的拿到號碼，後到的判不出。這種是當年位移在接縫處留下的複製品
   * （doctor1 106100 醫學(一) #20 與 #21 完全相同），它佔著號碼會害真正該
   * 用那個號碼的題改不回來。標 duplicate_record 讓前端隱藏，並把號碼讓出來。
   */
  const sig = q => flat(q.question) + '||' + ['A', 'B', 'C', 'D'].map(k => flat((q.options || {})[k])).join('|');
  const accepted = new Map(agree.map(r => [sig(r.q), r]));
  const dups = [];
  for (const r of clash) {
    const twin = accepted.get(sig(r.q));
    if (twin && twin.q !== r.q) dups.push({ q: r.q, twin: twin.q });
  }
  const dupSet = new Set(dups.map(d => d.q));
  if (dups.length) {
    console.log('\n完全重複（標 duplicate_record，讓出號碼）：');
    dups.forEach(d => console.log(`  #${d.q.number} 與 #${d.twin.number} 一模一樣  ${String(d.q.question).slice(0, 44).replace(/\s+/g, ' ')}`));
  }
  const clashKeep = clash.filter(r => !dupSet.has(r.q));
  if (clashKeep.length) {
    console.log('\n判不出題號（不動）：');
    clashKeep.slice(0, 12).forEach(r => console.log(`  #${r.q.number} 原卷前面的數字=${r.raw}  ${String(r.q.question).slice(0, 44).replace(/\s+/g, ' ')}`));
  }
  if (strays.length) {
    console.log('\n外來題（原卷找不到，標 wrong_source_paper）：');
    strays.forEach(q => console.log(`  #${q.number}  ${String(q.question).slice(0, 56).replace(/\s+/g, ' ')}`));
  }
  if (ambiguous.length) ambiguous.forEach(r => console.log(`  ⚠ #${r.q.number} ${r.why}`));

  // 撞號檢查：要改的新號碼彼此不能撞，也不能撞到「不動」的那些
  // 佔號的只算「前端還看得到、而且號碼不會變」的題。
  // 外來題與完全重複都會被標成 incomplete（前端隱藏），它們佔的號碼要讓出來，
  // 否則真正該用那個號碼的題改不回去（實測擋住 #22 與 #53）。
  const keep = new Set([...clashKeep.map(r => +r.q.number), ...ambiguous.map(r => +r.q.number)]);
  const want = new Map();
  for (const r of agree) {
    if (want.has(r.num)) { console.error(`✗ 新題號 #${r.num} 撞號，停手`); process.exit(1); }
    want.set(r.num, r);
  }
  const collide = [...want.keys()].filter(n => keep.has(n) && want.get(n).q.number !== n);
  if (collide.length) console.log(`\n⚠️ 新號碼與「不動的題」撞號：${collide.join(',')} —— 這些不改`);

  const plan = agree.filter(r => +r.q.number !== r.num && !collide.includes(r.num));
  console.log(`\n要改題號的：${plan.length} 題`);
  plan.slice(0, 10).forEach(r => console.log(`  #${r.q.number} → #${r.num}  ${String(r.q.question).slice(0, 40).replace(/\s+/g, ' ')}`));
  if (plan.length > 10) console.log(`  …還有 ${plan.length - 10} 題`);

  if (!APPLY) { console.log('\n(試跑；加 --apply 才寫入)'); return; }
  for (const r of plan) { r.q._shifted_from = r.q.number; r.q.number = r.num; }
  for (const q of strays) if (!q.incomplete) q.incomplete = 'wrong_source_paper';
  for (const d of dups) if (!d.q.incomplete) d.q.incomplete = 'duplicate_record';
  fs.writeFileSync(p0, JSON.stringify(j, null, 2), 'utf8');
  console.log(`\n已寫入：改號 ${plan.length} 題，標外來題 ${strays.length} 題，標完全重複 ${dups.length} 題`);
})().catch(e => { console.error(e.stack); process.exit(1); });
