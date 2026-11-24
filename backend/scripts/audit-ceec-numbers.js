#!/usr/bin/env node
/**
 * 稽核學測／分科題庫的**題號**。
 *
 * 為什麼題號這麼要緊：scrape-ceec.js 的答案是 `answerMap[題號]` —— 用題號去
 * 官方答案卷查。題號一錯，掛上去的就是**別題的答案**，而題幹看起來好好的，
 * 使用者答對了卻被判錯，完全沒有任何外顯症狀。
 *
 * 已知的兩種錯法：
 *   · 小數被當題號：「（光速 3.0×10⁸ m/s）」的「3.0」→ 第 3 題
 *     （解析器 2026-11-24 已加 (?![0-9]) 與「題號只會遞增」擋掉）
 *   · 表格數字被當題號：「1 67.3 24.6 100」→ 第 1 題
 *
 * 做法：用 lib/ceec-paper-segments（mupdf 逐行＋選項片段流）在原卷上找到
 * 這一題的 A~D(E) 連續選項段，再看那段之前最後出現的題號是多少。
 * 跟題庫存的題號不一樣 = 這題的答案很可能是別題的。
 *
 * 只報告，不改東西 —— 改題號連帶要改答案與 id，屬於 apply-record-patch 的範圍
 * （見 [[procedure_verify_before_commit]]）。
 *
 *   node scripts/audit-ceec-numbers.js [--exam=gsat] [--jsonl=out.jsonl]
 */
const fs = require('fs');
const path = require('path');
const { paperSegments, findOptionRuns, numberBefore } = require('./lib/ceec-paper-segments');

const BK = path.join(__dirname, '..');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const ONLY = arg('exam');
const JSONL = arg('jsonl');

const SUBJ = {
  國文: 'zh', 國語文綜合能力測驗: 'zh', 英文: 'en', 社會: 'social', 自然: 'science',
  歷史: 'history', 地理: 'geography', 公民: 'civics', 公民與社會: 'civics',
  物理: 'physics', 化學: 'chemistry', 生物: 'biology', 數學甲: 'mathA', 數學乙: 'mathB',
};

(async () => {
  const stats = {};
  const bad = [], rows = [];
  const bump = k => { stats[k] = (stats[k] || 0) + 1; };

  for (const f of ['questions-gsat.json', 'questions-ast.json']) {
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    for (const q of arr) {
      if (ONLY && !String(q.exam_code).startsWith(ONLY)) continue;
      const o = q.options || {};
      if (!o.A || !o.B || !o.C || !o.D) { bump('選項不齊，跳過'); continue; }
      const tag = `${q.exam_code}_${q.subject_tag || SUBJ[q.subject] || q.subject}`;
      const S = await paperSegments(tag);
      if (!S) { bump('本機沒有這份原卷'); continue; }

      const keys = ['A', 'B', 'C', 'D'].concat(o.E ? ['E'] : []);
      const runs = findOptionRuns(S.segs, o, keys);
      if (!runs.length) { bump('卷上對不到這題的選項'); continue; }
      if (runs.length > 1) { bump('卷上有多處選項一樣，確認不了'); continue; }
      const real = numberBefore(S.nums, runs[0]);
      if (real === null) { bump('選項之前找不到題號'); continue; }
      if (real === +q.number) { bump('題號正確'); continue; }

      bump('⚠️ 題號對不上');
      const row = {
        file: f, id: q.id, exam: q.exam_code, subject: q.subject,
        bankNum: +q.number, paperNum: real, answer: q.answer,
        question: String(q.question).slice(0, 80), options: o,
      };
      rows.push(row);
      bad.push(`${q.exam_code} ${q.subject} 題庫 #${q.number} → 卷上 #${real}  ans=${q.answer}  ${row.question}`);
    }
  }

  bad.sort();
  bad.forEach(b => console.log('  ' + b));
  if (JSONL) { fs.writeFileSync(JSONL, rows.map(r => JSON.stringify(r)).join('\n')); console.log(`\n明細 -> ${JSONL}`); }
  console.log('\n' + JSON.stringify(stats, null, 1));
})();
