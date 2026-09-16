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
const { fetchPdf, buildMoexUrl } = require('./lib/pdf-fetcher');
const { parseAnswerSheet } = require('./lib/moex-answer-sheet');

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
const PDF_DIR = path.join(DIR, '_tmp', 'bullet-cloze');
const UA = 'Mozilla/5.0';
const REF = 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx';

const { normText: norm, nameKey: keyName } = require('./lib/moex-normalize');
const { parseCorrections: sharedParseCorrections } = require('./lib/moex-pdf-parse');
const { probeCodes } = require('./lib/moex-paper-resolve');

// ⚠️ 一定要優先抓「更正答案卷」(t=M)，不能只看標準答案卷 (t=S)。
// 考選部常在事後發更正，備註寫「第4題答Ｂ、Ｃ給分」這種多答案給分。
// 只看 S 會把我們存的（更正後）答案誤判成錯誤 —— 2026-09-13 差點據此改掉
// 4 個正確答案（105100 醫學(二) #4/#16/#19/#58 全都在更正給分範圍內）。
async function getAnswerPdf(code, c, s) {
  fs.mkdirSync(PDF_DIR, { recursive: true });
  for (const t of ['M', 'S']) {
    const p = path.join(PDF_DIR, `${t}_${code}_${c}_${s}.pdf`);
    if (fs.existsSync(p) && fs.statSync(p).size > 1000) return { buf: fs.readFileSync(p), type: t };
    try {
      const buf = await fetchPdf(buildMoexUrl(t, code, c, s), { userAgent: UA, referer: REF });
      if (buf && buf.length > 1000) { fs.writeFileSync(p, buf); return { buf, type: t }; }
    } catch { /* 沒有更正卷就退回標準卷 */ }
  }
  throw new Error('no answer pdf');
}

/**
 * 更正備註解析走共用 lib（lib/moex-pdf-parse）。
 * 這裡原本自帶一份，漏了「除未作答者不給分外…」那種寫法，
 * 而且同一支 regex 在四支腳本各有一份、內容還不一樣——就是連續誤判的根源。
 * 本檔下游把多答案當成 'A,B' 字串處理，所以在這裡轉一次格式。
 */
function parseCorrections(text) {
  const out = {};
  for (const [n, v] of Object.entries(sharedParseCorrections(text))) {
    out[n] = Array.isArray(v) ? v.join(',') : v;
  }
  return out;
}


(async () => {
  const reports = JSON.parse(fs.readFileSync(path.join(DIR, '_tmp', 'untouched-reports.json'), 'utf8'))
    .filter(r => /答案|應為|應該是|給分|選錯/.test(String(r.message || '')))
    .filter(r => !/解析|詳解|解說/.test(String(r.message || '')));
  console.log(`主張答案錯誤的回報：${reports.length} 筆`);

  // 題幹 -> 題目（拿 exam_code / subject_tag / number / answer）
  const byText = new Map();
  const allQuestions = [];
  for (const f of fs.readdirSync(DIR).filter(x => /^questions(-.*)?\.json$/.test(x) && !/\.bak/.test(x))) {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    for (const q of (Array.isArray(j) ? j : j.questions) || []) {
      byText.set(norm(q.question), { file: f, q });
      allQuestions.push(q);
    }
  }

  // 依卷分組
  const papers = new Map();
  for (const r of reports) {
    const hit = byText.get(norm(r.question_text));
    if (!hit) continue;
    const q = hit.q;
    // 一定要用 subject（卷別）分組，不能用 subject_tag —— tag 是「主題分類」，
    // 同一卷裡會有多種 tag，用 tag 分組會把不同卷的題混進同一組，
    // 抓到的答案卷對不上題號就會產生假的「答案不符」（2026-09-13 誤報 2 題）。
    const k = `${hit.file}|${q.exam_code}|${q.subject}`;
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
        const got = await getAnswerPdf(p.code, cand.c, cand.s);
        A = await parseAny(got.buf);
        if (A && got.type === 'M') {
          // 更正卷的 ＃ 只代表「有更正」，真正內容在備註，要覆蓋回去
          const txt = await pdfText(got.buf);
          Object.assign(A, parseCorrections(txt));
        }
        if (A && Object.keys(A).length) break;
      } catch { /* 換下一個候選 */ }
    }
    if (!A || !Object.keys(A).length) { noParse += p.items.length; continue; }

    // ⚠️ 先驗「整卷對齊」再比對個別題。抓錯卷時題號照樣對得上，只是答案全亂，
    // 會產生一堆假的「答案不符」（2026-09-13 誤報：106020 醫學(二) 96 題有 63 題
    // 不一致，其實是抓到別卷；而 105100 醫學(二) 100 題只有 4 題不一致，那 4 題
    // 才是真的錯）。同卷一致率低於 85% 就當作抓錯卷，整卷跳過。
    const wholePaper = allQuestions.filter(q => String(q.exam_code) === p.code && q.subject === p.subject);
    let agree = 0, total = 0;
    for (const q of wholePaper) {
      const o = A[q.number];
      if (!o) continue;
      total++;
      if (String(o).trim() === String(q.answer).trim()) agree++;
    }
    if (total >= 10 && agree / total < 0.85) {
      console.log(`⨯ ${p.subject} ${p.code}：整卷一致率僅 ${(agree / total * 100).toFixed(0)}%（${agree}/${total}），判定抓錯卷，跳過`);
      noParse += p.items.length;
      continue;
    }

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
