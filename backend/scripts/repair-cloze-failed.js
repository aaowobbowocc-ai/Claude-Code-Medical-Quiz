#!/usr/bin/env node
/**
 * 重建 incomplete='cloze_parse_failed' 的題。
 *
 * 那個標記是當年題組解析失敗時打的（同一組題被填成一模一樣，只好整組隱藏）。
 * 現在有兩個新工具可以正面解決：選項 PUA 標記能精準切題與選項，
 * 文章擷取能把「請依下文回答第X題至第Y題」的文章帶回來。
 *
 *   node scripts/repair-cloze-failed.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper } = require('./lib/moex-paper-resolve');
const { answerMap } = require('./lib/moex-answer-geo');
const { paperQuestions } = require('./fill-civil-gaps');
const { paperPassages } = require('./fill-passage-context');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');

(async () => {
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f));
  let fixed = 0, skip = 0, errs = 0;
  for (const f of files) {
    const exam = f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '');
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions; if (!arr) continue;
    const targets = arr.filter(q => q.incomplete === 'cloze_parse_failed');
    if (!targets.length) continue;
    const groups = {};
    for (const q of targets) { const k = q.exam_code + '|' + q.subject; (groups[k] = groups[k] || []).push(q); }
    let touched = false;
    for (const k of Object.keys(groups)) {
      const [code, ...rest] = k.split('|'); const subject = rest.join('|');
      const items = arr.filter(q => q.exam_code === code && q.subject === subject);
      let qs, pgs, am, p;
      try {
        p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items });
        if (!p) { errs++; continue; }
        qs = await paperQuestions(code, p.c, p.s);
        pgs = await paperPassages(code, p.c, p.s);
        am = await answerMap(code, p.c, p.s, Math.max(items.length, qs.size), p.subject);
      } catch (e) { errs++; console.error(`  ! ${exam} ${code} ${subject}: ${String(e.message).slice(0, 50)}`); continue; }
      let n = 0;
      for (const q of groups[k]) {
        const num = +q.number;
        const src = qs.get(num);
        const ans = am && am.map.get(num);
        if (!src || !ans) { skip++; continue; }
        // 最後一個選項常黏到下一段文章的宣告（「avoid請依下文回答第11題至…」），切掉
        const cutTail = t => String(t || '').replace(/(?:請)?依下[文列]回答第[\s\S]*$/, '').trim();
        const opts = ['A', 'B', 'C', 'D'].map(x => cutTail(src.options[x]));
        if (opts.some(o => !o) || new Set(opts).size < 4) { skip++; continue; }
        const pg = pgs.find(x => num >= x.from && num <= x.to);
        let stem = String(src.stem || '').trim();
        if (stem.length < 10) {
          if (!pg) { skip++; continue; }                     // 空題幹又沒文章 → 還是不能作答
          stem = `依上文文意，選出最適合填入空格（${num}）的選項。`;
        }
        if (APPLY) {
          q.question = stem;
          q.options = { A: opts[0], B: opts[1], C: opts[2], D: opts[3] };
          q.answer = ans;
          if (pg) q.case_context = `（第 ${pg.from}～${pg.to} 題共用下文）${pg.passage}`;
          delete q.incomplete;
          touched = true;
        }
        n++; fixed++;
      }
      if (n) console.log(`${exam} ${code} ${subject}: ${APPLY ? '已重建' : '可重建'} ${n}/${groups[k].length} 題`);
    }
    if (APPLY && touched) fs.writeFileSync(path.join(BK, f), JSON.stringify(j, null, 2), 'utf8');
  }
  console.log(`\n${APPLY ? '已重建' : '可重建'} ${fixed} 題｜跳過 ${skip}${errs ? `｜⚠️ ${errs} 卷失敗` : ''}`);
})().catch(e => { console.error(e.stack); process.exit(1); });
