#!/usr/bin/env node
/**
 * 修「同場次別卷的題被複製進這一格」—— 題數是滿的，所以缺題盤點抓不到。
 *
 * 偵測（不用下載 PDF）：同一個 exam_code、同一個題號、不同科目，而題幹
 * （扣掉題組情境）一模一樣 → 其中至少一格是別卷的複本。
 *   · 牙醫二階 114090 卷三 #56 裝的是卷一 #56（危險因子）
 *   · 營養師 100030 食品衛生與安全 #9 裝的是公共衛生營養學 #9
 *   · 聽語 101110 基礎言語科學 #70/#72 裝的是兒童語言障礙 #70/#72
 * 答案欄跟著複本一起搬過來，所以「答案對齊率」看起來也是對的 ——
 * 既有稽核一條都看不到。見 project_cross_subject_overwrite。
 *
 * 哪一格才是假的，不靠猜：逐格回考選部原卷比對，題幹對不上自己那張卷的
 * 那一格才是假的。重建一律用原卷的題幹＋選項＋**答案卷**的答案
 * （舊答案是在描述別卷那一題，不能留）。id 不動。
 *
 *   node scripts/repair-alien-slot.js [--apply] [--exam=dental2]
 */
const fs = require('fs');
const path = require('path');
const { identifyPaper, rebuildOne, applyRebuild, cmp } = require('./lib/moex-one-question-rebuild');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];

/** 題組情境是印在卷上的引言，比對題幹時要扣掉。 */
const body = (q) => {
  const s = String(q.question || '');
  if (!s.startsWith('【題組情境】')) return s;
  const seg = s.split('\n\n');
  return seg[seg.length - 1];
};

(async () => {
  const files = fs.readdirSync(BK).filter(f => /^questions(-.*)?\.json$/.test(f) && !/\.bak/.test(f));
  let cand = 0, fixed = 0, skip = 0;

  for (const f of files) {
    const exam = f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '');
    if (only && exam !== only) continue;
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    if (!arr) continue;

    // 同 exam_code + 同題號、跨科目、題幹相同
    const groups = {};
    for (const q of arr) {
      const k = q.exam_code + '|' + q.number + '|' + cmp(body(q)).slice(0, 40);
      if (cmp(body(q)).length < 12) continue;
      (groups[k] = groups[k] || []).push(q);
    }
    const suspects = [];
    for (const g of Object.values(groups)) {
      if (g.length < 2) continue;
      if (new Set(g.map(q => q.subject)).size < 2) continue;
      suspects.push(...g);
    }
    if (!suspects.length) continue;
    cand += suspects.length;

    const papers = {};
    let dirty = false;
    for (const q of suspects) {
      const tag = `${exam} ${q.exam_code} ${q.subject} #${q.number}`;
      const key = q.exam_code + '|' + q.subject;
      if (papers[key] === undefined) {
        papers[key] = null;
        const items = arr.filter(x => x.exam_code === q.exam_code && x.subject === q.subject);
        const mineBad = suspects.filter((x) => x.exam_code === q.exam_code && x.subject === q.subject);
        try { papers[key] = await identifyPaper({ exam, code: q.exam_code, subject: q.subject, siblings: items, broken: mineBad }); }
        catch (e) { console.log('    (認卷例外 ' + e.message + ')'); }
      }
      const p = papers[key];
      if (!p) { console.log(`  ⊘ ${tag}：認不出是哪張卷`); skip++; continue; }
      const src = p.off.get(+q.number) || p.off.get(String(q.number));
      const k = cmp(body(q)).slice(0, 14);
      if (src && cmp(src.stem || '').includes(k)) { console.log(`  ○ ${tag}：對得上自己的卷（這一格是真的）`); continue; }

      const r = rebuildOne(p, q, (stem) => (cmp(stem).includes(k) ? '重解出來還是同一題' : null));
      if (!r.ok) { console.log(`  ⊘ ${tag}：${r.reason}`); skip++; continue; }
      console.log(`  ✓ ${tag}（認卷命中率 ${(p.hit * 100).toFixed(0)}%）`);
      console.log(`      舊 ${body(q).replace(/\s+/g, ' ').slice(0, 56)}  ans=${q.answer}`);
      console.log(`      新 ${r.stem.replace(/\s+/g, ' ').slice(0, 56)}  ans=${r.answer}`);
      for (const kk of ['A', 'B', 'C', 'D']) console.log(`        ${kk}. ${String(r.options[kk]).replace(/\s+/g, ' ').slice(0, 64)}`);
      if (APPLY) { applyRebuild(q, r); delete q.incomplete; dirty = true; }
      fixed++;
    }
    if (APPLY && dirty) fs.writeFileSync(path.join(BK, f), JSON.stringify(j, null, 2) + '\n', 'utf8');
  }
  console.log(`\n候選 ${cand} 格｜原卷重建${APPLY ? '已套用' : '可套用'} ${fixed}｜保留 ${skip}`);
})();
