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
const { execFileSync } = require('child_process');
const { fetchPdf, buildMoexUrl } = require('./lib/pdf-fetcher');
const { parseAnswerSheet } = require('./lib/moex-answer-sheet');

const DIR = path.join(__dirname, '..');
const CACHE = path.join(DIR, '_tmp', 'moex-codes.json');
const PDF_DIR = path.join(DIR, '_tmp', 'bullet-cloze');
const UA = 'Mozilla/5.0';
const REF = 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const EXAM = arg('--exam', 'doctor1');
const MIN = +arg('--min', '0.85');
const keyName = (t) => String(t).replace(/[（）()【】\[\]、，,。．.\s]/g, '');

const codeCache = (() => { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; } })();
function probeCodes(code, year) {
  if (codeCache[code]) return codeCache[code];
  try {
    const out = execFileSync('python', [path.join(__dirname, 'probe-moex-codes.py'), String(+year + 1911), code],
      { encoding: 'utf8', timeout: 180000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    const list = [];
    for (const line of out.split('\n')) {
      const m = line.match(/c=(\d+)\s+s=(\w+)\s+(.+)/);
      if (m) list.push({ c: m[1], s: m[2], subject: m[3].replace(/試題|答案|更正答案/g, '').trim() });
    }
    codeCache[code] = list;
  } catch { codeCache[code] = []; }
  fs.writeFileSync(CACHE, JSON.stringify(codeCache, null, 2), 'utf8');
  return codeCache[code];
}

/** 從更正卷備註解析「第N題答X、Y給分」/「第N題一律給分」。
 *  ⚠️ 沒有這段就會一直產生假警報：考選部常認定題目有瑕疵而放寬給分，
 *  我們存的答案雖與「標準答案」不同，卻在給分範圍內。2026-09-14 這個錯誤
 *  連續翻轉了三次結論，每次都是讀了備註才發現我們的資料是對的。 */
function parseCorrections(text) {
  const out = {};
  const i = text.indexOf('備');
  const body = i >= 0 ? text.slice(i) : text;
  for (const m of body.matchAll(/第\s*(\d{1,3})\s*題\s*(一律給分|除未作答者不給分外[^，。]*|答([ＡＢＣＤA-D、，,或\s]+)給分)/g)) {
    const n = +m[1];
    if (!m[3]) { out[n] = '送分'; continue; }
    const letters = (m[3].match(/[ＡＢＣＤA-D]/g) || [])
      .map(c => c.charCodeAt(0) > 0xFF00 ? String.fromCharCode(c.charCodeAt(0) - 0xFEE0) : c);
    if (letters.length) out[n] = [...new Set(letters)];
  }
  return out;
}

async function pdfText(buf) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  let all = '';
  for (let p = 0; p < doc.countPages(); p++) {
    const st = JSON.parse(doc.loadPage(p).toStructuredText('preserve-whitespace').asJSON());
    for (const b of st.blocks || []) for (const l of b.lines || []) all += (l.text || '').trim() + ' ';
  }
  return all;
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

    let A = null;
    for (const cand of cands) { A = await getSheet(p.code, cand.c, cand.s); if (A) break; }
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
      if (String(o).trim() === String(q.answer).trim()) same++;
      else diffs.push({ n: q.number, ours: q.answer, official: String(o).trim(), id: q.id });
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
  }
  fs.writeFileSync(path.join(DIR, '_tmp', `answer-suspects-${EXAM}.json`), JSON.stringify(suspects, null, 2), 'utf8');
  console.log(`\n清單已寫出 _tmp/answer-suspects-${EXAM}.json`);
})();
