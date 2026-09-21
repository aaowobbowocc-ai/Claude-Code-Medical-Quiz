#!/usr/bin/env node
/**
 * 重建「題幹只剩片語」的英文題（克漏字／閱讀測驗）。
 *
 * 這些題的題幹在抽取時被選項文字或文章碎片取代，使用者看到的是不能作答的東西。
 * 成因與 project_option_shift 同源：題組文章夾在題號之間，切點抓錯就整段錯位。
 *
 * 重建方式：
 *   克漏字（原卷該題號沒有自己的題幹）→ 題幹 = 整段文章，空格位置標成 __N__，
 *                                        末尾註明這題問第幾格
 *   閱讀測驗（原卷該題號有自己的題幹）→ 題幹 = 文章 + 換行 + 該題題幹
 *
 * 因為題幹與選項一起換掉，舊的答案「字母」不再可信（原本就可能是錯位留下的），
 * 一律改用考選部標準答案卷；取不到答案的題不動。
 *
 *   node scripts/repair-english-group-items.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper } = require('./lib/moex-paper-resolve');
const { paperQuestions } = require('./fill-civil-gaps');
const { paperPassages } = require('./fill-passage-context');
const { sheetMap } = require('./lib/moex-answer-geo');
const { atomicWriteJson } = require('./lib/atomic-write');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const rows = JSON.parse(fs.readFileSync(path.join(BK, '_tmp', 'fragment-stems.json'), 'utf8'))
  .filter(r => /英文/.test(r.subject));
const FILE = e => e === 'doctor1' ? 'questions.json' : `questions-${e}.json`;
const PUA = /[-]/;

/**
 * 文章裡的空格是裸露的題號。
 * 兩邊都必須是空白才算——只擋「前面不是數字」會把年份切開的
 * 「In 20 10, a South Korean couple…」的 10 當成第 10 格（實測 customs 108050）。
 * 而且要依序往後找，後面的空格不可能出現在前一個空格之前。
 */
function markBlanks(passage, from, to) {
  // 不要用 RegExp 字面量／樣板字串組 \s —— 反斜線在多層轉義裡會被吃掉，
  // 變成 (^|s) 而靜默地一個都標不到。直接照空白切 token 比較穩。
  const parts = passage.split(' ');   // passages() 已把空白正規化成單一空格
  let n = 0, k = from;
  for (let i = 0; i < parts.length && k <= to; i++) {
    if (parts[i] === String(k)) { parts[i] = `__${k}__`; k++; n++; }
  }
  return { text: parts.join(' '), marked: n };
}

const optsOf = o => ['A', 'B', 'C', 'D'].map(k => String(o[k] || '').trim());
const usable = a => a.length === 4 && a.every(t => t) && new Set(a).size === 4 && !a.some(t => PUA.test(t));

/**
 * 「碎片分數」：同一組選項裡有大寫開頭的，卻混著小寫開頭的那幾個，
 * 多半是題幹尾巴漏進選項（customs 108050 #21 的 A 是「osely related to this…」）。
 * 用來在「現有選項」與「原卷選項」之間挑比較不破的那一組。
 */
function fragScore(a) {
  const upper = a.filter(t => /^[A-Z]/.test(t)).length;
  if (upper < 2) return 0;                       // 整組都小寫（單字填空）就不適用
  return a.filter(t => /^[a-z]/.test(t)).length;
}

const groups = {};
for (const r of rows) (groups[`${r.exam}|${r.code}|${r.subject}`] = groups[`${r.exam}|${r.code}|${r.subject}`] || []).push(r);

(async () => {
  const banks = {}, plan = [], skip = [];
  for (const key of Object.keys(groups)) {
    const [exam, code, subject] = key.split('|');
    const f = FILE(exam);
    if (!banks[f]) { const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')); banks[f] = { raw: j, arr: Array.isArray(j) ? j : j.questions }; }
    const items = banks[f].arr.filter(q => q.exam_code === code && q.subject === subject);
    let src, ps, ans;
    try {
      const p = await resolvePaper({ exam, code, subject, year: code.slice(0, 3), items });
      if (!p) { groups[key].forEach(r => skip.push({ ...r, why: '對不到官方卷' })); continue; }
      src = await paperQuestions(code, p.c, p.s);
      ps = await paperPassages(code, p.c, p.s);
      ans = (await sheetMap(code, p.c, p.s, items.length)).map;
    } catch (e) { groups[key].forEach(r => skip.push({ ...r, why: '原卷處理失敗: ' + e.message.slice(0, 40) })); continue; }

    for (const r of groups[key]) {
      const q = banks[f].arr.find(x => String(x.id) === String(r.id));
      if (!q) { skip.push({ ...r, why: '題庫找不到 id' }); continue; }
      const grp = ps.find(x => r.n >= x.from && r.n <= x.to);
      if (!grp) { skip.push({ ...r, why: '不在任何題組範圍內（單題,非克漏字）' }); continue; }
      const s = src.get(r.n);
      if (!s) { skip.push({ ...r, why: '原卷解析不到該題號' }); continue; }
      // 選項以「我們現有的」為準：這些題壞的是題幹，選項多半早就人工核對過，
      // 而原卷抽出來的反而可能被排版切碎（police4 107070 #20 的 essential → ssentiale）。
      // 只有現有選項本身壞掉時，才改用原卷的。
      const mine = optsOf(q.options || {});
      const fromSrc = optsOf(s.options || {});
      // 兩組都可用時，挑碎片分數低的；平手才沿用現有（現有多半已人工核對過）
      const keepMine = usable(mine) && (!usable(fromSrc) || fragScore(mine) <= fragScore(fromSrc));
      const opts = keepMine ? mine : fromSrc;
      if (!usable(opts)) { skip.push({ ...r, why: '現有與原卷的選項都不完整' }); continue; }
      // 換掉選項就等於舊的答案字母失效，改用標準答案卷；沒換就保留原答案
      const official = keepMine ? q.answer : ans.get(r.n);
      if (!official) { skip.push({ ...r, why: '取不到官方答案' }); continue; }

      const { text, marked } = markBlanks(grp.passage, grp.from, grp.to);
      const ownStem = String(s.stem || '').trim();
      // 克漏字的題號在原卷沒有自己的題幹（空格在文章裡）；閱測則有
      const isCloze = ownStem.length < 12;
      if (isCloze && !marked) { skip.push({ ...r, why: '文章裡標不出空格位置' }); continue; }
      const stem = isCloze
        ? `${text}\n\n（請選出第 ${r.n} 格的最佳答案）`
        : `${grp.passage}\n\n${ownStem}`;
      if (stem.length < 60) { skip.push({ ...r, why: '重建後題幹過短' }); continue; }

      plan.push({ ...r, file: f, kind: isCloze ? '克漏字' : '閱讀測驗', newAns: official, optSrc: keepMine ? '沿用現有' : '取自原卷',
        newStem: stem.replace(/\s+/g, ' ').slice(0, 100), opts });
      if (APPLY) {
        q.question = stem;
        q.options = { A: opts[0], B: opts[1], C: opts[2], D: opts[3] };
        q.answer = official;
        if (q.incomplete === 'cloze_parse_failed') delete q.incomplete;
      }
    }
  }
  console.log(`可重建 ${plan.length} 題，跳過 ${skip.length} 題\n`);
  plan.forEach(r => console.log(`  ✓ ${r.exam} ${r.code} #${r.n} [${r.kind}/選項${r.optSrc}] 答 ${r.ans}→${r.newAns}${r.ans !== r.newAns ? ' ⚠答案改變' : ''}\n      ${r.newStem}\n      ${r.opts.map(t => t.slice(0, 22)).join(' / ')}`));
  const byWhy = {}; skip.forEach(r => (byWhy[r.why] = (byWhy[r.why] || 0) + 1));
  if (skip.length) { console.log('\n跳過原因:'); Object.entries(byWhy).forEach(([w, n]) => console.log(`  ${n} 題 — ${w}`)); }
  fs.writeFileSync(path.join(BK, '_tmp', 'english-group-plan.json'), JSON.stringify({ plan, skip }, null, 1), 'utf8');
  if (APPLY) { for (const f of new Set(plan.map(r => r.file))) atomicWriteJson(path.join(BK, f), banks[f].raw); console.log(`\n已寫回 ${new Set(plan.map(r => r.file)).size} 個題庫檔`); }
  else console.log('\n(試跑；加 --apply 才寫入)');
})().catch(e => { console.error(e.stack); process.exit(1); });
