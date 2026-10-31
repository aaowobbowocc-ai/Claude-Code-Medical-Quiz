#!/usr/bin/env node
/**
 * 把學測／分科題組的共用文章補到既有題庫上。
 *
 * 2026-10-31 使用者回報「題目不完整，只有選項」（學測 103 英文 #27）、
 * 「題目不完整」（106 英文 #47）。查出來是系統性的：
 *
 *   1. `parseQuestions` 的題組宣告 regex 錨在 `^(\d{1,2})`，
 *      但英文卷寫的是「第16至20題為題組」—— 開頭那個「第」讓整條失效，
 *      **16 個年度的英文題組文章全部沒抓到**。
 *   2. 就算抓到了，`buildQuestions` 也從來沒有把 `pq.passage` 寫出去。
 *
 * 兩個都已修在 scrape-ceec.js 裡，但**不能靠重跑爬蟲來修既有資料** ——
 * 爬蟲是整卷覆寫，會連帶動到已經人工核對過的題（見 feedback_scraper_year_flag）。
 * 所以這支只做一件事：拿原卷的文章，補上 `case_context`，其他欄位一律不動。
 *
 * **身分驗證**：只有當題庫的四個選項與原卷同題號的四個選項**完全相同**
 * （正規化後）才掛上去。題號對得上不代表是同一題，掛錯文章比沒有文章更糟。
 *
 * 克漏字（題幹本身就是選項列，因為空格在文章裡）另外把題幹換成卷上的
 * 作答指示；文章裡的空格會標成 __N__ 並註明本題問第幾格。
 *
 *   node scripts/fill-ceec-passages.js [--exam gsat] [--apply]
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const pdfParse = require('pdf-parse');
const { REGISTRY, BASE, parseQuestions } = require('./scrape-ceec');
const { passageContext } = require('./lib/cloze-blanks');

const BK = path.join(__dirname, '..');
const CACHE = path.join(BK, '_tmp', 'ceec-pdf');
const APPLY = process.argv.includes('--apply');
const ei = process.argv.indexOf('--exam');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1]
  || (ei > 0 ? process.argv[ei + 1] : null) || null;

/** 題幹就是選項列 → 這是克漏字，空格在文章裡，卷上沒有題幹。 */
const OPTS_AS_STEM = /^\s*\(?\s*A\s*\)?[.、]?\s/;
const norm = t => String(t || '').replace(/\s/g, '').normalize('NFC').toLowerCase();

function download(url, r = 0) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, x => {
      if ([301, 302, 303, 307, 308].includes(x.statusCode) && r < 5)
        return res(download(new URL(x.headers.location, url).href, r + 1));
      const b = []; x.on('data', d => b.push(d)).on('end', () => res(Buffer.concat(b)));
    }).on('error', rej);
  });
}

async function officialQs(exam, year, tag) {
  const entry = REGISTRY[exam] && REGISTRY[exam].years[year] && REGISTRY[exam].years[year][tag];
  if (!entry || !entry.q) return null;
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, `${exam}_${year}_${tag}.pdf`);
  let buf;
  if (fs.existsSync(f) && fs.statSync(f).size > 10000) buf = fs.readFileSync(f);
  else { buf = await download(BASE + entry.q); fs.writeFileSync(f, buf); }
  return parseQuestions((await pdfParse(buf)).text);
}

(async () => {
  const added = [], skipped = {};
  const bump = w => { skipped[w] = (skipped[w] || 0) + 1; };

  for (const exam of ['gsat', 'ast']) {
    if (only && exam !== only) continue;
    const def = REGISTRY[exam];
    const file = path.join(BK, def.outputFile);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    // 中文科目名 → REGISTRY 的 tag，直接從 REGISTRY 取，不另抄一張表
    const tagOf = Object.fromEntries(def.subjects.map(s => [s.name, s.tag]));

    const groups = {};
    for (const q of arr) {
      if (!q || !q.exam_code) continue;
      (groups[`${q.exam_code}|${q.subject}`] = groups[`${q.exam_code}|${q.subject}`] || []).push(q);
    }

    let touched = false;
    for (const key of Object.keys(groups).sort()) {
      const [code, subject] = key.split('|');
      const year = code.replace(/^.*_/, '');
      const tag = tagOf[subject];
      if (!tag) { groups[key].forEach(() => bump(`科目名對不到 REGISTRY tag（${subject}）`)); continue; }
      let off;
      try { off = await officialQs(exam, year, tag); } catch (e) { groups[key].forEach(() => bump('原卷處理失敗: ' + e.message.slice(0, 40))); continue; }
      if (!off) { groups[key].forEach(() => bump(`REGISTRY 沒有 ${exam} ${year} ${tag}`)); continue; }
      const byNum = new Map(off.map(q => [Number(q.num), q]));

      let n = 0;
      for (const q of groups[key]) {
        if (q.case_context) { bump('已經有 case_context'); continue; }
        const o = byNum.get(Number(q.number));
        if (!o) { bump('原卷解析不到該題號'); continue; }
        if (!o.passage) { bump('這題不屬於任何題組'); continue; }
        // 身分驗證：四個選項要完全相同，否則寧可不掛
        const mine = ['A', 'B', 'C', 'D'].map(k => norm((q.options || {})[k]));
        const theirs = ['A', 'B', 'C', 'D'].map(k => norm((o.options || {})[k]));
        if (mine.join('|') !== theirs.join('|')) { bump('選項對不上原卷（不確定是同一題）'); continue; }

        const ctx = passageContext(o);
        if (!ctx) { bump('文章組不出來'); continue; }
        // 題幹裡已經有這段文章就不要再掛一次。先前有一批題組是把文章
        // 直接寫進題幹的，兩邊都放會讓使用者看到同一篇兩次。
        const head = norm(o.passage).slice(0, 40);
        if (head && norm(q.question).includes(head)) { bump('題幹已經含這段文章'); continue; }
        const isCloze = OPTS_AS_STEM.test(String(q.question || ''));
        const row = { exam, code, subject, n: q.number, kind: isCloze ? '克漏字' : '閱讀測驗' };
        if (APPLY) {
          q.case_context = ctx;
          // 克漏字的題幹在卷上是空的（空格在文章裡），現在存的是選項列的複製。
          // 換成卷上「說明」段自己的作答指示，不要留著那份重複。
          if (isCloze) q.question = `請依文意選出第 ${q.number} 格最適當的一個選項`;
          touched = true;
        }
        added.push(row); n++;
      }
      if (n) console.log(`${exam} ${code} ${subject}: ${APPLY ? '已補' : '可補'} ${n} 題`);
    }
    if (APPLY && touched) fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n', 'utf8');
  }

  const kinds = added.reduce((m, r) => (m[r.kind] = (m[r.kind] || 0) + 1, m), {});
  console.log(`\n${APPLY ? '已補' : '可補'} ${added.length} 題  ${Object.entries(kinds).map(([k, v]) => k + ' ' + v).join('、')}`);
  if (Object.keys(skipped).length) {
    console.log('\n沒有動的：');
    for (const [w, n] of Object.entries(skipped).sort((a, b) => b[1] - a[1])) console.log(`  ${n} 題 — ${w}`);
  }
  console.log(APPLY ? '' : '\n(試跑；加 --apply 才寫入)');
})().catch(e => { console.error(e.stack); process.exit(1); });
