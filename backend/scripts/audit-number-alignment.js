#!/usr/bin/env node
/**
 * 逐題確認「我們的第 N 題，在原卷也是第 N 題」。
 *
 * 不要用 pdfQuestions 的題號→題幹 Map 來做這件事：它在部分版型會把題號切錯，
 * 回傳的「原卷第 N 題」其實是句子片段（藥師卷三實測），於是好題被誤判成錯位。
 * 可靠的來源是 pdfText 的閱讀順序：在扁平文字裡找到我們的題幹，
 * 再看它前面最近的「題號數字」是不是 N。
 *
 *   node scripts/audit-number-alignment.js [--exam vet]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper, fetchSheet } = require('./lib/moex-paper-resolve');
const { pdfText } = require('./lib/moex-pdf-parse');

const BK = path.join(__dirname, '..');
const OUT = path.join(BK, '_tmp', 'number-alignment.json');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];
const checks = JSON.parse(fs.readFileSync(path.join(BK, '_tmp', 'numbering-check.json'), 'utf8'))
  .filter(r => r.verdict === '題號對得上→答案有問題').filter(r => !only || r.exam === only);
const FILE = e => e === 'doctor1' ? 'questions.json' : `questions-${e}.json`;
const banks = {};
const flat = s => String(s).replace(/\s+/g, '');
const done = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : [];
const seen = new Set(done.map(r => r.key));

(async () => {
  let n = 0;
  for (const r of checks) {
    n++;
    if (seen.has(r.key)) continue;
    const f = FILE(r.exam);
    if (!banks[f]) { const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')); banks[f] = Array.isArray(j) ? j : j.questions; }
    const items = banks[f].filter(q => q.exam_code === r.code && q.subject === r.subject);
    const rec = { key: r.key, exam: r.exam, code: r.code, subject: r.subject, bad: [], notFound: 0, ok: 0 };
    try {
      const p = await resolvePaper({ exam: r.exam, code: r.code, subject: r.subject, year: String(r.code).slice(0, 3), items });
      if (!p) rec.err = '對不到官方卷';
      else {
        const ft = flat(await pdfText(await fetchSheet('Q', r.code, p.c, p.s)));
        for (const it of items) {
          // 題組情境已內嵌的題，題幹是以「領頭那一題」的文字開頭，一定會定位到領頭的
          // 題號（#39 落在 #38）。那是正常的，不是錯位——直接跳過，否則整批假警報。
          if (/【題組情境】|承上題|承上圖|承前一題/.test(String(it.question))) { rec.skipped = (rec.skipped || 0) + 1; continue; }
          const stem = flat(it.question);
          let probe = null;
          for (const len of [24, 18, 14]) { const s2 = stem.slice(0, len); if (s2.length >= 12) { if (ft.includes(s2)) { probe = s2; break; } } }
          if (!probe) { rec.notFound++; continue; }
          const i = ft.indexOf(probe);
          // 題幹前方最近的一串數字就是它在原卷的題號
          // 題號前面常黏著頁首（「頁次：6－3」→ "63"）或上一題選項的數字，
          // 所以不能取「最後 1~3 位數」當題號，要看數字串是否**以**我們的題號結尾。
          const before = ft.slice(Math.max(0, i - 8), i);
          const m = /(\d{1,8})$/.exec(before);
          if (!m) { rec.notFound++; continue; }
          if (m[1].endsWith(String(it.number))) rec.ok++;
          else rec.bad.push({ n: it.number, id: it.id, srcDigits: m[1], ans: it.answer,
            stem: String(it.question).replace(/\s+/g, ' ').slice(0, 40) });
        }
      }
    } catch (e) { rec.err = e.message.slice(0, 60); }
    done.push(rec);
    fs.writeFileSync(OUT, JSON.stringify(done, null, 1), 'utf8');
    if (rec.err || rec.bad.length) console.log(`[${n}/${checks.length}] ${r.exam} ${r.code} ${r.subject} → ${rec.err || `對齊 ${rec.ok}, 錯位 ${rec.bad.length}, 定位不到 ${rec.notFound}`}`);
  }
  const bad = done.reduce((s, r) => s + (r.bad ? r.bad.length : 0), 0);
  const ok = done.reduce((s, r) => s + (r.ok || 0), 0);
  console.log(`\n題號確認對齊 ${ok} 題，真正錯位 ${bad} 題`);
})().catch(e => { console.error(e.stack); process.exit(1); });
