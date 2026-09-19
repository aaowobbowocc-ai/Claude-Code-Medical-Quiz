#!/usr/bin/env node
/**
 * 盤點公職卷（警察/警特四等/關務）的缺題。
 *
 * 這些卷是「申論題 + 測驗題」混合，只有測驗題進題庫。官方卷裡測驗題那段
 * 會先寫「共N題」，題號格式是「1 題幹」（數字後接空白，不是 1. 或 1、），
 * 所以一般的題號 regex 抓不到——之前誤判成「沒有缺題」。
 *
 *   node scripts/audit-civil-gaps.js [--exam police]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { pdfText } = require('./lib/moex-pdf-parse');

const BK = path.join(__dirname, '..');
const OUT = path.join(BK, '_tmp', 'civil-gaps.json');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];
const EXAMS = only ? [only] : ['police', 'police4', 'customs'];
const done = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : [];
const seen = new Set(done.map(r => r.key));

(async () => {
  const jobs = [];
  for (const exam of EXAMS) {
    const f = `questions-${exam}.json`;
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const a = Array.isArray(j) ? j : j.questions;
    const g = {};
    for (const q of a) { if (!q.exam_code) continue; const k = q.exam_code + '|' + q.subject; (g[k] = g[k] || []).push(q); }
    for (const k of Object.keys(g)) jobs.push({ exam, f, code: k.split('|')[0], subject: k.split('|').slice(1).join('|'), items: g[k] });
  }
  console.log('待盤點', jobs.length, '卷');
  let n = 0;
  for (const job of jobs) {
    n++;
    const key = job.exam + '|' + job.code + '|' + job.subject;
    if (seen.has(key)) continue;
    const rec = { key, exam: job.exam, code: job.code, subject: job.subject, ours: job.items.length };
    try {
      const p = await resolvePaper({ exam: job.exam, code: job.code, subject: job.subject, year: String(job.code).slice(0, 3), items: job.items });
      if (!p) rec.err = '對不到官方卷';
      else {
        const txt = await pdfText(await fetchSheet('Q', job.code, p.c, p.s));
        // 「共25 題」「共 50 題」都要吃到
        const m = /共\s*(\d{1,3})\s*題/.exec(txt);
        rec.declared = m ? +m[1] : null;
        // 題號：行首或空白後的數字，且後面接中文/英文題幹
        const nums = [...txt.matchAll(/(?:^|\s)(\d{1,3})\s+(?=[一-龥A-Za-z(（])/gm)]
          .map(x => +x[1]).filter(x => x >= 1 && x <= 200);
        rec.maxParsed = nums.length ? Math.max(...nums) : 0;
        const target = rec.declared || rec.maxParsed;
        const have = new Set(job.items.map(q => +q.number));
        rec.missing = [];
        for (let i = 1; i <= target; i++) if (!have.has(i)) rec.missing.push(i);
        rec.target = target;
      }
    } catch (e) { rec.err = e.message.slice(0, 50); }
    done.push(rec);
    fs.writeFileSync(OUT, JSON.stringify(done, null, 1), 'utf8');
    if (rec.err || (rec.missing && rec.missing.length))
      console.log(`[${n}/${jobs.length}] ${rec.exam} ${rec.code} ${rec.subject} → 我方 ${rec.ours}/官方 ${rec.target || '?'}，缺 ${rec.missing ? rec.missing.length : '?'} 題 ${rec.err || ''}`);
  }
  const tot = done.reduce((s, r) => s + ((r.missing && r.missing.length) || 0), 0);
  console.log('\n合計缺題', tot, '題，涉及', done.filter(r => r.missing && r.missing.length).length, '卷');
})().catch(e => { console.error(e.stack); process.exit(1); });
