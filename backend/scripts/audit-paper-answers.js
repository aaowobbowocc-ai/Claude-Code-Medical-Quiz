#!/usr/bin/env node
/**
 * 整卷答案稽核：拿考選部答案卷逐卷比對，找出真正答錯的題。
 *
 * 為什麼不是直接比字母就好：我們的選項順序不一定與原卷相同（見
 * procedure_answer_dispute_check）。所以先用「整卷一致率」確認抓到的是同一卷、
 * 且選項順序一致（一致率高代表順序相同），再把少數不一致的挑出來人工判讀。
 * 一致率低就是抓錯卷或選項順序不同，整卷跳過，不產生假警報。
 *
 * ⚠️ 已知限制：整卷一致率高**不代表**選項順序與原卷相同。100030 醫學(二) 一致率
 * 達標，但部分題目的選項順序與原卷不同（原卷 A=Thiopental，我們存成 B），
 * 於是字母對不上卻其實答案正確。**看到 suspects 一定要逐題比對「選項文字」再下結論**，
 * 不能只看字母。2026-09-14 這個陷阱讓同一批題被誤判成錯誤三次。
 *
 * 用法：
 *   node scripts/audit-paper-answers.js --exam doctor1
 *   node scripts/audit-paper-answers.js --exam doctor1 --min 0.85
 */

const fs = require('fs');
const path = require('path');
const { fetchPdf, buildMoexUrl } = require('./lib/pdf-fetcher');
const { parseAnswerSheet } = require('./lib/moex-answer-sheet');

const DIR = path.join(__dirname, '..');
const PDF_DIR = path.join(DIR, '_tmp', 'bullet-cloze');
const UA = 'Mozilla/5.0';
const REF = 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const EXAM = arg('--exam', 'doctor1');
const MIN = +arg('--min', '0.85');
const { nameKey: keyName, sameName } = require('./lib/moex-normalize');
// 解析器一律走共用 lib：更正備註的 regex 曾因為各腳本各一份而漏「者」「均」，
// 連續四次把正確答案判成錯誤。probeCodes 同理，空結果不要寫進快取。
const { parseCorrections, pdfText, pdfQuestions } = require('./lib/moex-pdf-parse');
const { skeleton } = require('./lib/moex-normalize');
const { probeCodes } = require('./lib/moex-paper-resolve');

/** 試題卷（t=Q），拿選項文字用 */
async function getQSheet(code, c, s) {
  const p = path.join(PDF_DIR, `Q_${code}_${c}_${s}.pdf`);
  if (fs.existsSync(p) && fs.statSync(p).size > 1000) return fs.readFileSync(p);
  const buf = await fetchPdf(buildMoexUrl('Q', code, c, s), { userAgent: UA, referer: REF });
  if (!buf || buf.length <= 1000) throw new Error('no Q pdf');
  fs.mkdirSync(PDF_DIR, { recursive: true });
  fs.writeFileSync(p, buf);
  return buf;
}

async function getSheet(code, c, s) {
  for (const t of ['M', 'S']) {
    const p = path.join(PDF_DIR, `${t}_${code}_${c}_${s}.pdf`);
    let buf = null;
    if (fs.existsSync(p) && fs.statSync(p).size > 1000) buf = fs.readFileSync(p);
    else {
      try {
        buf = await fetchPdf(buildMoexUrl(t, code, c, s), { userAgent: UA, referer: REF });
        if (buf && buf.length > 1000) fs.writeFileSync(p, buf); else buf = null;
      } catch { buf = null; }
    }
    if (!buf) continue;
    try {
      const A = await parseAnswerSheet(buf);
      if (A && Object.keys(A).length) {
        // 更正卷的 ＃ 只表示「有更正」，真正內容在備註，要覆蓋回去
        if (t === 'M') Object.assign(A, parseCorrections(await pdfText(buf)));
        return A;
      }
    } catch {}
  }
  return null;
}

(async () => {
  const file = EXAM === 'doctor1' ? 'questions.json' : `questions-${EXAM}.json`;
  const j = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  const arr = (Array.isArray(j) ? j : j.questions) || [];

  const papers = new Map();
  for (const q of arr) {
    if (!q.exam_code || !q.subject) continue;
    const k = `${q.exam_code}|${q.subject}`;
    if (!papers.has(k)) papers.set(k, { code: String(q.exam_code), subject: q.subject, year: q.roc_year, items: [] });
    papers.get(k).items.push(q);
  }
  console.log(`${EXAM}：${papers.size} 卷\n`);

  const suspects = [];
  let audited = 0, skipped = 0;
  for (const p of papers.values()) {
    const cands = probeCodes(p.code, p.year).filter(x => {
      const xk = keyName(x.subject), pk = keyName(p.subject);
      return xk === pk || xk.startsWith(pk) || pk.startsWith(xk);
    });
    if (!cands.length) { skipped++; continue; }

    let A = null, official = null;
    for (const cand of cands) {
      A = await getSheet(p.code, cand.c, cand.s);
      if (!A) continue;
      // 一併抓試題卷的選項文字。字母比對不可信：我們的選項順序與原卷常常不同，
      // 「我們 B、官方 A」多半只是排序差異，內容其實一樣。
      // 2026-09 連續四次「答案有誤」的誤判就是這樣來的，所以一定要比文字。
      try { official = await pdfQuestions(await getQSheet(p.code, cand.c, cand.s)); } catch { official = null; }
      break;
    }
    if (!A) { skipped++; continue; }

    let same = 0, total = 0; const diffs = [];
    for (const q of p.items) {
      const o = A[q.number];
      if (!o) continue;
      // 更正為多答案時，我們的答案只要落在給分範圍內就算正確
      if (Array.isArray(o)) {
        total++;
        const ours = String(q.answer).split(/[,、\s]+/).filter(Boolean);
        if (ours.length && ours.every(x => o.includes(x))) same++;
        else diffs.push({ n: q.number, ours: q.answer, official: o.join(','), id: q.id, corrected: true });
        continue;
      }
      if (o === '送分') { total++; same++; continue; }   // 一律給分，存什麼都不算錯
      if (!/^[A-D]$/.test(String(o).trim())) continue;
      total++;
      if (String(o).trim() === String(q.answer).trim()) { same++; continue; }
      // 字母不同 → 再比選項文字，一樣就是排序差異，不是答案錯
      const off = official && official.get(q.number);
      if (off) {
        const ourTxt = skeleton((q.options || {})[q.answer] || '');
        const offTxt = skeleton(off.options['ABCD'.indexOf(String(o).trim())] || '');
        if (ourTxt && offTxt && (ourTxt.includes(offTxt) || offTxt.includes(ourTxt))) { same++; continue; }
      }
      diffs.push({ n: q.number, ours: q.answer, official: String(o).trim(), id: q.id,
        oursText: String((q.options || {})[q.answer] || '').slice(0, 40),
        officialText: off ? String(off.options['ABCD'.indexOf(String(o).trim())] || '').slice(0, 40) : null });
    }
    if (total < 10) { skipped++; continue; }
    const rate = same / total;
    if (rate < MIN) { skipped++; continue; }   // 抓錯卷或選項順序不同

    audited++;
    for (const d of diffs) suspects.push({ code: p.code, subject: p.subject, year: p.year, ...d });
  }

  console.log(`稽核 ${audited} 卷（跳過 ${skipped} 卷：反查不到科目／答案卷拿不到／一致率過低）`);
  console.log(`\n⚠️ 疑似答案錯誤：${suspects.length} 題`);
  const byLetter = {};
  for (const s of suspects) byLetter[s.ours] = (byLetter[s.ours] || 0) + 1;
  console.log('  我們的答案字母分布:', JSON.stringify(byLetter));
  for (const s of suspects.slice(0, 20)) {
    console.log(`  ${s.code} ${s.subject} #${s.n}  我們=${s.ours} 官方=${s.official}  (id ${s.id})`);
    if (s.officialText) console.log(`      我們: ${s.oursText}
      官方: ${s.officialText}`);
  }
  fs.writeFileSync(path.join(DIR, '_tmp', `answer-suspects-${EXAM}.json`), JSON.stringify(suspects, null, 2), 'utf8');
  console.log(`\n清單已寫出 _tmp/answer-suspects-${EXAM}.json`);
})();
