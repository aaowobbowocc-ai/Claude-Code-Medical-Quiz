#!/usr/bin/env node
/**
 * 答案對齊率低有兩種完全不同的原因，處理方式相反：
 *   A. 題號對得上、答案錯  → 可以用官方答案卷覆寫（藥師卷三就是這型）
 *   B. 題號對不上          → 答案其實沒錯，是我們的 number 與官方不同
 *                            （公職卷把「法學知識與英文」拆成兩科重新編號就會這樣）
 * 覆寫 B 型會把一整卷正確答案改成錯的。所以先逐題比對「同一題號的題幹」。
 *
 *   node scripts/verify-paper-numbering.js            讀 _tmp/audit-bad.json
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { pdfQuestions } = require('./lib/moex-pdf-parse');
const { skeleton } = require('./lib/moex-normalize');

const BK = path.join(__dirname, '..');
const bad = JSON.parse(fs.readFileSync(path.join(BK, '_tmp', 'audit-bad.json'), 'utf8'));
const OUT = path.join(BK, '_tmp', 'numbering-check.json');
const done = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : [];
const seen = new Set(done.map(r => r.key));

(async () => {
  let n = 0;
  for (const p of bad) {
    n++;
    if (seen.has(p.key)) continue;
    const j = JSON.parse(fs.readFileSync(path.join(BK, p.f), 'utf8'));
    const a = Array.isArray(j) ? j : j.questions;
    const items = a.filter(q => q.exam_code === p.code && q.subject === p.subject);
    const rec = { key: p.key, exam: p.exam, code: p.code, subject: p.subject, n: items.length, ansRate: p.rate };
    try {
      const rp = await resolvePaper({ exam: p.exam, code: p.code, subject: p.subject, year: String(p.code).slice(0, 3), items });
      if (!rp) rec.err = '對不到官方卷';
      else {
        const qs = await pdfQuestions(await fetchSheet('Q', p.code, rp.c, rp.s));
        let same = 0, differ = 0, absent = 0;
        for (const it of items) {
          const src = qs.get(+it.number);
          if (!src) { absent++; continue; }
          const A = skeleton(it.question || '').slice(0, 24), B = skeleton(src.stem || '').slice(0, 24);
          if (!A || !B) { absent++; continue; }
          if (A === B) same++; else differ++;
        }
        rec.sameNum = same; rec.diffNum = differ; rec.absent = absent;
        rec.numRate = (same + differ) ? +(same / (same + differ)).toFixed(2) : null;
        rec.verdict = rec.numRate == null ? '無法判定'
          : rec.numRate >= 0.9 ? '題號對得上→答案有問題'
          : rec.numRate <= 0.3 ? '題號對不上→答案可能沒錯'
          : '部分對得上→需人工';
      }
    } catch (e) { rec.err = e.message.slice(0, 60); }
    done.push(rec);
    fs.writeFileSync(OUT, JSON.stringify(done, null, 1), 'utf8');
    console.log(`[${n}/${bad.length}] ${rec.exam} ${rec.code} ${rec.subject} 答案${(100*(rec.ansRate||0)).toFixed(0)}% 題號${rec.numRate==null?'?':(100*rec.numRate).toFixed(0)+'%'} → ${rec.err||rec.verdict}`);
  }
  const v = {}; done.forEach(r => v[r.err || r.verdict] = (v[r.err || r.verdict] || 0) + 1);
  console.log('\n判定分布:', JSON.stringify(v, null, 1));
})().catch(e => { console.error(e.stack); process.exit(1); });
