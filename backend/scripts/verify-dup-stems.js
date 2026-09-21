#!/usr/bin/env node
/**
 * 驗證「同一卷同一科目、兩個題號卻是同一個題幹」的每一組。
 *
 * 有三種可能，處理方式完全不同，不能一律當成事故：
 *   1. 原卷真的出現兩次（含圖題不同圖、英文克漏字整段文章當題幹）→ 兩筆都對，不動
 *   2. 原卷只出現一次 → 其中一筆是被別題蓋掉的，要修或隱藏
 *   3. 定位不到 → 版型問題，人工處理
 *
 * 判定題號的規則同 audit-number-alignment.js：看題幹前面那串數字是否「以」該題號結尾
 * （前面常黏著頁首「頁次：6－3」或上一題選項的數字）。
 *
 *   node scripts/verify-dup-stems.js
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { pdfText } = require('./lib/moex-pdf-parse');
const { answerMap } = require('./lib/moex-answer-geo');
const { skeleton } = require('./lib/moex-normalize');

const BK = path.join(__dirname, '..');
const OUT = path.join(BK, '_tmp', 'dup-stem-verdicts.json');
const groups = JSON.parse(fs.readFileSync(path.join(BK, '_tmp', 'dup-stem.json'), 'utf8'))
  .filter(g => new Set(g.items.map(i => i.ans)).size > 1);
const FILE = e => e === 'doctor1' ? 'questions.json' : `questions-${e}.json`;
const banks = {};
const flat = s => String(s).replace(/\s+/g, '');
const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : [];
const seen = new Set(out.map(r => r.key));

(async () => {
  for (const g of groups) {
    const [code, subject] = g.k.split('|');
    const key = `${g.f}|${g.k}|${g.items.map(i => i.n).join(',')}`;
    if (seen.has(key)) continue;
    const f = FILE(g.f);
    if (!banks[f]) { const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')); banks[f] = Array.isArray(j) ? j : j.questions; }
    const items = banks[f].filter(q => q.exam_code === code && q.subject === subject);
    const rec = { key, exam: g.f, code, subject, stem: g.q, nums: g.items.map(i => i.n), hits: [], official: {} };
    try {
      const p = await resolvePaper({ exam: g.f, code, subject, year: String(code).slice(0, 3), items });
      if (!p) rec.err = '對不到官方卷';
      else {
        const ft = skeleton(await pdfText(await fetchSheet('Q', code, p.c, p.s)));
        // 兩筆題幹都試：其中一筆可能已經被寫壞，用壞的那筆當 probe 會定位不到。
        // 比對一律走 skeleton（NFKC＋去標點）——原卷的全形括號、下標拆行都會讓純去空白的比對失敗。
        let probe = null;
        for (const it of g.items) {
          const q = items.find(x => x.id === it.id); if (!q) continue;
          const full = skeleton(q.question);
          for (const len of [40, 30, 22, 16]) { const s2 = full.slice(0, len); if (s2.length >= 14 && ft.includes(s2)) { probe = s2; break; } }
          if (probe) break;
        }
        if (!probe) rec.err = '題幹在原卷定位不到';
        else {
          for (let i = ft.indexOf(probe); i >= 0; i = ft.indexOf(probe, i + 1)) {
            const m = /(\d{1,8})$/.exec(ft.slice(Math.max(0, i - 8), i));
            rec.hits.push(m ? m[1] : null);
          }
          try {
            const am = await answerMap({ code, c: p.c, s: p.s, expected: items.length });
            for (const n of rec.nums) if (am && am[n]) rec.official[n] = am[n];
          } catch (e) { rec.ansErr = e.message.slice(0, 40); }
        }
      }
    } catch (e) { rec.err = e.message.slice(0, 60); }
    // 原卷出現次數 vs 我們的筆數
    rec.verdict = rec.err ? '無法判定'
      : rec.hits.length >= rec.nums.length ? '原卷本來就重複→兩筆都合法'
      : `原卷只出現 ${rec.hits.length} 次、我們有 ${rec.nums.length} 筆→有覆蓋`;
    out.push(rec);
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1), 'utf8');
    console.log(`${g.f} ${code} ${subject} #${rec.nums.join('/')} → ${rec.verdict}`);
    if (rec.hits.length) console.log(`    原卷題號: ${rec.hits.join(', ')}  官方答案: ${JSON.stringify(rec.official)}`);
  }
})().catch(e => { console.error(e.stack); process.exit(1); });
