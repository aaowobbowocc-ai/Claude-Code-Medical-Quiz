#!/usr/bin/env node
/**
 * 拿考選部標準答案卷整卷比普考共用題庫（行政學概要／行政法概要）的答案。
 *
 * 起因：回報 #936（111 行政學概要 #20「非正式組織」）我們存 C、官方是 B，
 * 而這題的選項完全正常——代表錯的不是解析，是答案本身，那就該整批比對。
 *
 * 兩道防呆（同 procedure_answer_audit_sitewide）：
 *   1. 題幹必須逐題號對得上原卷，否則「答案不同」很可能只是我們的題號與官方不同
 *   2. 答案卷配對數必須等於題數，部分匯入的卷硬比會全錯
 *
 *   node scripts/audit-civil-junior-answers.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const { paperQuestions } = require('./fill-civil-gaps');
const { sheetMap } = require('./lib/moex-answer-geo');
const { skeleton } = require('./lib/moex-normalize');
const { atomicWriteJson } = require('./lib/atomic-write');
const { SESSIONS, SUBJECTS } = require('./scrape-civil-junior-admin');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const BANKS = [['admin_studies', 'common_admin_studies_junior.json'], ['admin_law', 'common_admin_law_junior.json']];

(async () => {
  const diffs = [], papers = [];
  for (const [bankKey, file] of BANKS) {
    const p = path.join(BK, 'shared-banks', file);
    if (!fs.existsSync(p)) continue;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = Array.isArray(raw) ? raw : raw.questions;
    let dirty = false;

    for (const ses of SESSIONS) {
      const sub = SUBJECTS.find(x => x.bank === bankKey && (!x.onlyYears || x.onlyYears.includes(ses.year)));
      if (!sub) continue;
      const items = arr.filter(q => String(q.roc_year) === ses.year);
      if (!items.length) continue;
      const rec = { file, year: ses.year, have: items.length, ok: 0, diff: 0, unmatched: 0, noStem: 0 };
      try {
        const src = await paperQuestions(ses.code, sub.c, sub.s);
        const sheet = await sheetMap(ses.code, sub.c, sub.s, 50);
        rec.sheet = `${sheet.map.size}/50 (${sheet.mode})`;
        if (sheet.map.size < 50) { rec.why = '答案卷配對不足，整卷跳過'; papers.push(rec); continue; }
        for (const q of items) {
          const n = +q.number;
          const s = src.get(n);
          const official = sheet.map.get(n);
          if (!official) { rec.unmatched++; continue; }
          // 題幹逐題號比對：對不上就不能動答案（可能是我們的題號與官方不同）
          if (!s) { rec.noStem++; continue; }
          const a = skeleton(q.question), b = skeleton(s.stem || '');
          if (!a || !b || !(a.startsWith(b.slice(0, 18)) || b.startsWith(a.slice(0, 18)))) { rec.noStem++; continue; }
          if (q.answer === official) { rec.ok++; continue; }
          rec.diff++;
          diffs.push({ file, year: ses.year, n, id: q.id, old: q.answer, neu: official,
            q: String(q.question).replace(/\s+/g, ' ').slice(0, 44),
            opt: ['A', 'B', 'C', 'D'].map(k => String((q.options || {})[k] || '').slice(0, 14)).join('/') });
          if (APPLY) { q.answer = official; dirty = true; }
        }
      } catch (e) { rec.why = '原卷處理失敗: ' + e.message.slice(0, 40); }
      papers.push(rec);
      console.log(`${file} ${ses.year} → 相符 ${rec.ok}、不符 ${rec.diff}、題幹對不上 ${rec.noStem}${rec.why ? ' — ' + rec.why : ''}`);
    }
    if (APPLY && dirty) atomicWriteJson(p, raw);
  }

  console.log(`\n答案與官方不符：${diffs.length} 題`);
  fs.writeFileSync(path.join(BK, '_tmp', 'civil-junior-answer-audit.json'), JSON.stringify({ papers, diffs }, null, 1), 'utf8');
  diffs.slice(0, 30).forEach(d => console.log(`  ${d.year} #${d.n} ${d.old}→${d.neu} | ${d.q} | ${d.opt}`));
  console.log(APPLY ? '\n已寫回' : '\n(試跑；加 --apply 才寫入)');
})().catch(e => { console.error(e.stack); process.exit(1); });
