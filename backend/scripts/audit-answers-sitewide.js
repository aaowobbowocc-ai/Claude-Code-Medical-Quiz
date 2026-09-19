#!/usr/bin/env node
/**
 * 全站答案稽核：每一卷都抓考選部標準答案卷，與題庫答案逐題比對。
 *
 * 為什麼要整卷比而不是單題比：單題比對會得到大量假警報（選項順序、多重答案、
 * 更正卷）。整卷對齊率才是可信訊號——實測正常卷 95-100%，壞卷 29-35%。
 *
 * 只記錄、不寫入。修復由 fix-paper-answers.js 依本報告進行。
 *
 *   node scripts/audit-answers-sitewide.js [--exam medlab] [--resume]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { pdfText, parseCorrections } = require('./lib/moex-pdf-parse');
const { sheetMap } = require('./lib/moex-answer-geo');

const BK = path.join(__dirname, '..');
const OUT = path.join(BK, '_tmp', 'answer-audit.json');
// 這些考試不是考選部來源（或用不同的 code 體系），resolvePaper 對不到
const SKIP = new Set(['gsat', 'ast', 'driver-car', 'driver-moto', 'post-indoor', 'post-outdoor',
  'railway-admin', 'railway-transport', 'state-finance', 'state-hr', 'state-it', 'state-mgmt',
  'teacher-elementary', 'teacher-kindergarten', 'teacher-secondary', 'teacher-special', 'teacher-special-gifted']);

const argExam = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];
const resume = process.argv.includes('--resume');

const EXAM = f => f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '');

(async () => {
  const files = fs.readdirSync(BK).filter(f => /^questions(-[a-z0-9-]*)?\.json$/.test(f));
  const done = resume && fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : [];
  const seen = new Set(done.map(r => r.key));
  let n = 0, total = 0;

  const jobs = [];
  for (const f of files) {
    const exam = EXAM(f);
    if (SKIP.has(exam)) continue;
    if (argExam && exam !== argExam) continue;
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const a = Array.isArray(j) ? j : j.questions; if (!a) continue;
    const g = {};
    for (const q of a) { if (!q.exam_code) continue; const k = q.exam_code + '|' + q.subject; (g[k] = g[k] || []).push(q); }
    for (const k of Object.keys(g)) jobs.push({ f, exam, code: k.split('|')[0], subject: k.split('|').slice(1).join('|'), items: g[k] });
  }
  total = jobs.length;
  console.log('待稽核', total, '卷（已完成', seen.size, '）');

  for (const job of jobs) {
    n++;
    const key = job.f + '|' + job.code + '|' + job.subject;
    if (seen.has(key)) continue;
    const rec = { key, f: job.f, exam: job.exam, code: job.code, subject: job.subject, n: job.items.length };
    try {
      const p = await resolvePaper({ exam: job.exam, code: job.code, subject: job.subject, year: String(job.code).slice(0, 3), items: job.items });
      if (!p) { rec.err = '對不到官方卷'; }
      else {
        rec.c = p.c; rec.s = p.s; rec.stemHit = p.hitRate != null ? p.hitRate : 1;
        const sm = await sheetMap(job.code, p.c, p.s, job.items.length);
        let hit = 0, tot = 0; const diff = [];
        for (const it of job.items) {
          const v = sm.map.get(+it.number); if (!v) continue;
          tot++; if (v === it.answer) hit++; else diff.push({ n: it.number, ours: it.answer, off: v });
        }
        rec.matched = tot; rec.hit = hit; rec.rate = tot ? +(hit / tot).toFixed(3) : null; rec.mode = sm.mode;
        rec.diff = diff.slice(0, 100);
        if (rec.rate != null && rec.rate < 0.9) {
          try { rec.corr = parseCorrections(await pdfText(await fetchSheet('M', job.code, p.c, p.s))); } catch (_) { rec.corr = null; }
        }
      }
    } catch (e) { rec.err = e.message.slice(0, 80); }
    done.push(rec);
    fs.writeFileSync(OUT, JSON.stringify(done, null, 1), 'utf8');
    const tag = rec.err ? 'ERR ' + rec.err : (rec.rate == null ? '無對齊' : (100 * rec.rate).toFixed(0) + '%');
    if (rec.err || rec.rate == null || rec.rate < 0.95) console.log(`[${n}/${total}] ${job.exam} ${job.code} ${job.subject} → ${tag}`);
  }
  // 第二階段（verify-paper-numbering.js）要吃的清單：題幹對得上、答案卻 <90% 的卷
  const bad = done.filter(r => !r.err && r.rate != null && r.rate < 0.9 && (r.stemHit == null || r.stemHit >= 0.9));
  const BAD = path.join(BK, '_tmp', 'audit-bad.json');
  fs.writeFileSync(BAD, JSON.stringify(bad, null, 1), 'utf8');
  console.log('完成。報告：', OUT);
  console.log(`可疑卷 ${bad.length} 卷（${bad.reduce((s2, r) => s2 + r.n, 0)} 題）→ ${BAD}`);
  console.log('下一步：node scripts/verify-paper-numbering.js');
})().catch(e => { console.error(e.stack); process.exit(1); });
