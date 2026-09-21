#!/usr/bin/env node
/**
 * 修「題幹只剩一個片語」的題——題幹在抽取時被選項文字或前一題的殘句取代了。
 * 例：clinical-psychology 103100 #11 題幹變成「Transient global amnesia, TGA」，
 * 但四個選項（僅③④⑤⑥⑦⑧…）其實是對的，只有題幹壞掉。
 *
 * 只改題幹，不動選項與答案。動手前一定要確認「這個題號的選項確實是我們手上這組」，
 * 否則遇到的其實是整題被別題蓋掉（tcm1 102110 #60 那種），只補題幹會做出一筆
 * 題幹與選項互不相干的題——比原本更糟。
 *
 * 選項比對有兩層：
 *   1. 骨架完全相同 → 安全
 *   2. 圈圈數字在原卷是私有造字、抽出來會塌成 ①①③③（見 reference_option_markers 第 3 點），
 *      此時比「去掉圈圈數字後的文字 + 圈圈數字個數」
 *
 *   node scripts/repair-fragment-stems.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper } = require('./lib/moex-paper-resolve');
const { paperQuestions } = require('./fill-civil-gaps');
const { skeleton, normText } = require('./lib/moex-normalize');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const rows = JSON.parse(fs.readFileSync(path.join(BK, '_tmp', 'fragment-stems.json'), 'utf8'));
const FILE = e => e === 'doctor1' ? 'questions.json' : `questions-${e}.json`;
const CIRCLE = /[①-⑳㉑-㉟㊱-㊿]/g;
const PUA = /[-]/;

/** 圈圈數字可能塌掉，所以比「去掉圈圈後的文字」與「圈圈個數」 */
const shape = o => ['A', 'B', 'C', 'D'].map(k => {
  const t = String(o[k] || '');
  return skeleton(t.replace(CIRCLE, '')) + '#' + (t.match(CIRCLE) || []).length;
}).join('|');
const exact = o => ['A', 'B', 'C', 'D'].map(k => skeleton(String(o[k] || ''))).join('|');

const groups = {};
for (const r of rows) (groups[`${r.exam}|${r.code}|${r.subject}`] = groups[`${r.exam}|${r.code}|${r.subject}`] || []).push(r);

(async () => {
  const banks = {}, plan = [], skip = [];
  for (const key of Object.keys(groups)) {
    const [exam, code, subject] = key.split('|');
    const f = FILE(exam);
    if (!banks[f]) { const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')); banks[f] = { raw: j, arr: Array.isArray(j) ? j : j.questions }; }
    const items = banks[f].arr.filter(q => q.exam_code === code && q.subject === subject);
    let src;
    try {
      const p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items });
      if (!p) { groups[key].forEach(r => skip.push({ ...r, why: '對不到官方卷' })); continue; }
      src = await paperQuestions(code, p.c, p.s);
    } catch (e) { groups[key].forEach(r => skip.push({ ...r, why: '原卷解析失敗: ' + e.message.slice(0, 40) })); continue; }

    for (const r of groups[key]) {
      const q = banks[f].arr.find(x => x.id === r.id);
      const s = src.get(r.n);
      if (!q) { skip.push({ ...r, why: '題庫找不到 id' }); continue; }
      if (!s) { skip.push({ ...r, why: '原卷解析不到該題號' }); continue; }
      // 英文填空題的空格在 PDF 裡就是一段空白，抽出來會變成「His father was and put in jail」。
      // 還原成底線，否則使用者看到的是一個讀不通的句子。
      const stem = normText(s.stem).length ? s.stem.trim().replace(/ {3,}/g, ' _____ ') : '';
      if (!stem || stem.length < 12) { skip.push({ ...r, why: '原卷題幹太短' }); continue; }
      if (PUA.test(stem)) { skip.push({ ...r, why: '原卷題幹殘留 PUA' }); continue; }
      if (skeleton(stem) === skeleton(q.question)) { skip.push({ ...r, why: '與現有題幹相同' }); continue; }
      // 已經補過題組文章的題，現有題幹會比原卷單題的題幹長得多——不要拿短的蓋回去
      if (skeleton(q.question).length > skeleton(stem).length) { skip.push({ ...r, why: '現有題幹較完整(已補過文章),不覆蓋' }); continue; }
      const okExact = exact(q.options || {}) === exact(s.options || {});
      const okShape = shape(q.options || {}) === shape(s.options || {});
      if (!okExact && !okShape) { skip.push({ ...r, why: '選項對不上→可能是整題被蓋掉,不能只補題幹', srcOpt: ['A','B','C','D'].map(k=>String(s.options[k]||'').slice(0,18)).join('/') }); continue; }
      plan.push({ ...r, file: f, newStem: stem, via: okExact ? '選項完全相同' : '選項結構相同(圈圈數字塌掉)' });
      if (APPLY) { q.question = stem; if (q.incomplete === 'cloze_parse_failed') delete q.incomplete; }
    }
  }
  console.log(`可修 ${plan.length} 題，跳過 ${skip.length} 題`);
  plan.forEach(r => console.log(`  ✓ ${r.exam} ${r.code} ${r.subject} #${r.n} [${r.via}]\n      舊: ${r.stem.slice(0, 50)}\n      新: ${r.newStem.replace(/\s+/g, ' ').slice(0, 90)}`));
  const byWhy = {}; skip.forEach(r => (byWhy[r.why] = (byWhy[r.why] || 0) + 1));
  console.log('\n跳過原因:'); Object.entries(byWhy).forEach(([w, n]) => console.log(`  ${n} 題 — ${w}`));
  fs.writeFileSync(path.join(BK, '_tmp', 'fragment-stem-plan.json'), JSON.stringify({ plan, skip }, null, 1), 'utf8');
  if (APPLY) {
    const { atomicWriteJson } = require('./lib/atomic-write');
    for (const f of new Set(plan.map(r => r.file))) atomicWriteJson(path.join(BK, f), banks[f].raw);
    console.log(`\n已寫回 ${new Set(plan.map(r => r.file)).size} 個題庫檔`);
  } else console.log('\n(試跑；加 --apply 才寫入)');
})().catch(e => { console.error(e.stack); process.exit(1); });
