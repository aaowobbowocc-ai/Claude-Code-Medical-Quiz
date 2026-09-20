#!/usr/bin/env node
/**
 * 重建 incomplete='broken_options' 的題（選項解析失敗而被隱藏）。
 * 用選項 PUA 標記（U+E18C~E18F）精準切，寫入前驗收：四個選項不得空、
 * 不得重複、不得殘留 PUA、不得黏到下一段文章宣告。
 *
 *   node scripts/repair-broken-options.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper } = require('./lib/moex-paper-resolve');
const { answerMap } = require('./lib/moex-answer-geo');
const { paperQuestions } = require('./fill-civil-gaps');
const { paperPassages } = require('./fill-passage-context');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const cutTail = t => String(t || '').replace(/(?:請)?依下[文列]回答第[\s\S]*$/, '').trim();

(async () => {
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f));
  let fixed = 0, skip = 0, errs = 0;
  const why = {};
  for (const f of files) {
    const exam = f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '');
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions; if (!arr) continue;
    const targets = arr.filter(q => q.incomplete === 'broken_options');
    if (!targets.length) continue;
    const groups = {};
    for (const q of targets) { const k = q.exam_code + '|' + q.subject; (groups[k] = groups[k] || []).push(q); }
    let touched = false;
    for (const k of Object.keys(groups)) {
      const [code, ...rest] = k.split('|'); const subject = rest.join('|');
      const items = arr.filter(q => q.exam_code === code && q.subject === subject);
      let qs, am, pgs = [];
      try {
        const p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items });
        if (!p) { errs++; why['對不到官方卷'] = (why['對不到官方卷'] || 0) + groups[k].length; continue; }
        qs = await paperQuestions(code, p.c, p.s);
        am = await answerMap(code, p.c, p.s, Math.max(items.length, qs.size), p.subject);
        try { pgs = await paperPassages(code, p.c, p.s); } catch (_) {}
      } catch (e) { errs++; console.error(`  ! ${exam} ${code} ${subject}: ${String(e.message).slice(0, 50)}`); continue; }
      let n = 0;
      for (const q of groups[k]) {
        const num = +q.number, src = qs.get(num), ans = am && am.map.get(num);
        if (!src) { skip++; why['原卷解析不出'] = (why['原卷解析不出'] || 0) + 1; continue; }
        if (!ans) { skip++; why['答案卷取不到'] = (why['答案卷取不到'] || 0) + 1; continue; }
        const opts = ['A', 'B', 'C', 'D'].map(x => cutTail(src.options[x]));
        if (opts.some(o => !o)) { skip++; why['有空選項'] = (why['有空選項'] || 0) + 1; continue; }
        if (new Set(opts).size < 4) { skip++; why['選項重複'] = (why['選項重複'] || 0) + 1; continue; }
        if (/[-]/.test(opts.join('') + src.stem)) { skip++; why['殘留PUA'] = (why['殘留PUA'] || 0) + 1; continue; }
        const pg = pgs.find(x => num >= x.from && num <= x.to);
        let stem = String(src.stem || '').trim();
        if (stem.length < 10) {
          if (!pg) { skip++; why['題幹過短且無文章'] = (why['題幹過短且無文章'] || 0) + 1; continue; }
          stem = `依上文文意，選出最適合填入空格（${num}）的選項。`;
        }
        if (APPLY) {
          q.question = stem;
          q.options = { A: opts[0], B: opts[1], C: opts[2], D: opts[3] };
          q.answer = ans;
          if (pg && !q.case_context) q.case_context = `（第 ${pg.from}～${pg.to} 題共用下文）${pg.passage}`;
          delete q.incomplete;
          touched = true;
        }
        n++; fixed++;
      }
      if (n) console.log(`${exam} ${code} ${subject}: ${APPLY ? '已重建' : '可重建'} ${n}/${groups[k].length}`);
    }
    if (APPLY && touched) fs.writeFileSync(path.join(BK, f), JSON.stringify(j, null, 2), 'utf8');
  }
  console.log(`\n${APPLY ? '已重建' : '可重建'} ${fixed} 題｜跳過 ${skip}`);
  if (Object.keys(why).length) console.log('跳過原因:', JSON.stringify(why, null, 1));
})().catch(e => { console.error(e.stack); process.exit(1); });
