#!/usr/bin/env node
/**
 * 針對「使用者主張答案錯誤」的回報，抓考選部官方答案卷比對。
 *
 * 為什麼不用 verify-moex-answers.js：那支是掃全站快取 PDF 的，這次跑起來
 * examined=389 skipped=389（快取裡的答案卷對應不到），而我們只需要處理
 * 有回報的那幾卷，直接抓比較快也比較準。
 *
 * 答案差異的處理規則見 CLAUDE.md / feedback_official_corrections：
 *   「答X給分」單字母 → 改答案 + 標 disputed
 *   多字母或「一律給分」 → 保留原答案 + 標 disputed
 * 這支只「報告」差異，不自動改，因為答案是最不能出錯的欄位。
 *
 * 用法：node scripts/verify-reported-answers.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { fetchPdf, buildMoexUrl } = require('./lib/pdf-fetcher');
const { parseAnswerSheet } = require('./lib/moex-answer-sheet');
const { parseAnswersColumnAware } = require('./lib/moex-column-parser');

// 不同年度的答案卷版型不一樣：新式是「題號/答案」兩列對齊的表格，舊式是欄位式。
// 兩支都試，取解析出題數較多的那個。
async function parseAny(buf) {
  const results = [];
  for (const fn of [parseAnswerSheet, parseAnswersColumnAware]) {
    try { const r = await fn(buf); if (r && Object.keys(r).length) results.push(r); } catch {}
  }
  if (!results.length) return null;
  return results.sort((a, b) => Object.keys(b).length - Object.keys(a).length)[0];
}

const DIR = path.join(__dirname, '..');
const CACHE = path.join(DIR, '_tmp', 'moex-codes.json');
const PDF_DIR = path.join(DIR, '_tmp', 'bullet-cloze');
const UA = 'Mozilla/5.0';
const REF = 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx';

const norm = (t) => String(t).normalize('NFC').replace(/\s+/g, '');
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

async function getAnswerPdf(code, c, s) {
  const p = path.join(PDF_DIR, `S_${code}_${c}_${s}.pdf`);
  if (fs.existsSync(p) && fs.statSync(p).size > 1000) return fs.readFileSync(p);
  fs.mkdirSync(PDF_DIR, { recursive: true });
  const buf = await fetchPdf(buildMoexUrl('S', code, c, s), { userAgent: UA, referer: REF });
  fs.writeFileSync(p, buf);
  return buf;
}

(async () => {
  const reports = JSON.parse(fs.readFileSync(path.join(DIR, '_tmp', 'untouched-reports.json'), 'utf8'))
    .filter(r => /答案|應為|應該是|給分|選錯/.test(String(r.message || '')))
    .filter(r => !/解析|詳解|解說/.test(String(r.message || '')));
  console.log(`主張答案錯誤的回報：${reports.length} 筆`);

  // 題幹 -> 題目（拿 exam_code / subject_tag / number / answer）
  const byText = new Map();
  for (const f of fs.readdirSync(DIR).filter(x => /^questions(-.*)?\.json$/.test(x) && !/\.bak/.test(x))) {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    for (const q of (Array.isArray(j) ? j : j.questions) || []) {
      byText.set(norm(q.question), { file: f, q });
    }
  }

  // 依卷分組
  const papers = new Map();
  for (const r of reports) {
    const hit = byText.get(norm(r.question_text));
    if (!hit) continue;
    const q = hit.q;
    const k = `${hit.file}|${q.exam_code}|${q.subject_tag}`;
    if (!papers.has(k)) papers.set(k, { file: hit.file, code: String(q.exam_code), tag: q.subject_tag, subject: q.subject, year: q.roc_year, items: [] });
    papers.get(k).items.push({ r, q });
  }
  console.log(`對應 ${papers.size} 卷\n`);

  const mismatches = [];
  let checked = 0, noCode = 0, noParse = 0;

  for (const p of papers.values()) {
    const cands = probeCodes(p.code, p.year).filter(x => {
      const xk = keyName(x.subject), pk = keyName(p.subject);
      return xk === pk || xk.startsWith(pk) || pk.startsWith(xk);
    });
    if (!cands.length) { noCode += p.items.length; continue; }

    let A = null;
    for (const cand of cands) {
      try {
        const buf = await getAnswerPdf(p.code, cand.c, cand.s);
        A = await parseAny(buf);
        if (A && Object.keys(A).length) break;
      } catch { /* 換下一個候選 */ }
    }
    if (!A || !Object.keys(A).length) { noParse += p.items.length; continue; }

    for (const { r, q } of p.items) {
      const official = A[q.number] ?? A[String(q.number)];
      if (!official) continue;
      checked++;
      if (String(official).trim() !== String(q.answer).trim()) {
        mismatches.push({ exam: p.file, where: `${q.roc_year}${q.session} #${q.number}`,
          ours: q.answer, official: String(official).trim(),
          msg: String(r.message).replace(/\n/g, ' ').slice(0, 55), reportId: r.id, qid: q.id });
      }
    }
  }

  console.log(`實際比對 ${checked} 題，反查不到科目 ${noCode} 題，答案卷解析失敗 ${noParse} 題`);
  console.log(`\n⚠️ 與官方答案不符：${mismatches.length} 題`);
  for (const m of mismatches) {
    console.log(`\n[${m.exam.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '')}] ${m.where}  我們=${m.ours} 官方=${m.official}`);
    console.log(`   回報: ${m.msg}`);
  }
  fs.writeFileSync(path.join(DIR, '_tmp', 'answer-mismatches.json'), JSON.stringify(mismatches, null, 2), 'utf8');
})();
