#!/usr/bin/env node
/**
 * 把「選項實質重複」的題逐一對回原卷，看原卷長什麼樣。
 * 主題庫走 resolvePaper，共用題庫走 audit-shared-bank-answers 的 buildPapers()。
 *
 *   node scripts/probe-dup-options.js
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper } = require('./lib/moex-paper-resolve');
const { paperQuestions } = require('./fill-civil-gaps');
const { sheetMap } = require('./lib/moex-answer-geo');
const { buildPapers } = require('./audit-shared-bank-answers');

const BK = path.join(__dirname, '..');
const rows = JSON.parse(fs.readFileSync(path.join(BK, '_tmp', 'real-dup.json'), 'utf8'));
const FILE = e => e === 'doctor1' ? 'questions.json' : `questions-${e}.json`;
const SHARED = new Set(['common_admin_studies_junior', 'common_law_knowledge', 'common_english',
  'common_public_mgmt', 'common_state_english', 'common_politics', 'common_local_gov',
  'common_law_basics', 'common_chinese', 'common_constitution', 'common_admin_law',
  'common_admin_studies', 'common_admin_law_junior']);

(async () => {
  const papers = buildPapers();
  for (const r of rows) {
    console.log(`\n=== ${r.ex} ${r.code} ${r.subj} #${r.n} 答${r.ans}`);
    console.log('  我們的:', r.o.map(t => t.slice(0, 30)).join(' / '));
    let pr = null;
    try {
      if (SHARED.has(r.ex)) {
        const cand = papers.filter(p => p.bank === r.ex && String(p.year) === String(r.code));
        if (!cand.length) { console.log('  → 共用題庫沒有這年的卷別表'); continue; }
        pr = { code: cand[0].code, c: cand[0].c, s: cand[0].s };
      } else {
        const j = JSON.parse(fs.readFileSync(path.join(BK, FILE(r.ex)), 'utf8'));
        const a = Array.isArray(j) ? j : j.questions;
        const items = a.filter(q => String(q.exam_code) === String(r.code) && q.subject === r.subj);
        const p = await resolvePaper({ exam: r.ex, code: String(r.code), subject: r.subj, year: String(r.code).slice(0, 3), items });
        if (!p) { console.log('  → 對不到官方卷'); continue; }
        pr = { code: String(r.code), c: p.c, s: p.s };
      }
      const src = await paperQuestions(pr.code, pr.c, pr.s);
      const s = src.get(+r.n);
      if (!s) { console.log('  → 原卷解析不到該題號'); continue; }
      console.log('  原卷題幹:', String(s.stem).replace(/\s+/g, ' ').slice(0, 70));
      console.log('  原卷選項:', ['A', 'B', 'C', 'D'].map(k => String(s.options[k] || '').slice(0, 30)).join(' / '));
      try {
        const sh = await sheetMap(pr.code, pr.c, pr.s, 50);
        console.log('  官方答案:', sh.map.get(+r.n) || '(取不到)');
      } catch (_) { console.log('  官方答案: (答案卷取不到)'); }
    } catch (e) { console.log('  → 失敗:', e.message.slice(0, 50)); }
  }
})().catch(e => { console.error(e.stack); process.exit(1); });
