#!/usr/bin/env node
/**
 * 判斷「解說與答案矛盾」的題到底是**解說錯**還是**答案錯**。
 *
 * 為什麼需要：2,180 筆矛盾裡兩種都有。抽驗看到護理師精神衛生法那題是解說錯，
 * 但關務英文 114-1 #9「Jane remained ___ and continued to pursue her dreams」
 * 我們存 fragile、解說說 resilient —— 那次是**答案錯**（選項位移導致字母錯位）。
 * 在錯的答案上重寫解說只會把錯誤固化，所以必須先分類。
 *
 * 方法：跟考選部原卷比**選項文字**，不是比字母
 *   官方答案字母 → 原卷該字母的選項文字
 *   我們的答案字母 → 我們該字母的選項文字
 *   兩段文字一致  → 我們的答案是對的 → 解說錯，可以重寫解說
 *   兩段文字不同  → 我們的答案錯（選項順序/字母錯位）→ 要先修答案
 * 比字母會誤判，因為我們的選項順序不一定與原卷相同（見 procedure_answer_dispute_check）。
 *
 * 用法：node scripts/classify-answer-vs-explanation.js [--limit N]
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
const LIMIT = process.argv.includes('--limit') ? +process.argv[process.argv.indexOf('--limit') + 1] : 40;

const norm = (t) => String(t || '').normalize('NFC').replace(/\s+/g, '');
const skel = (t) => norm(t).replace(/[（）()［］\[\]【】、，,。．.：:；;？?！!"'`~～－\-—–_]/g, '');
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

async function getPdf(type, code, c, s) {
  const p = path.join(PDF_DIR, `${type}_${code}_${c}_${s}.pdf`);
  if (fs.existsSync(p) && fs.statSync(p).size > 1000) return fs.readFileSync(p);
  fs.mkdirSync(PDF_DIR, { recursive: true });
  const buf = await fetchPdf(buildMoexUrl(type, code, c, s), { userAgent: UA, referer: REF });
  fs.writeFileSync(p, buf);
  return buf;
}

/** 從試題 PDF 取「題號 → 四個選項文字」。標記式版型（A.xxx）與幾何版型都試。 */
async function pdfOptions(buf) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  const lines = [];
  for (let p = 0; p < doc.countPages(); p++) {
    const st = JSON.parse(doc.loadPage(p).toStructuredText('preserve-whitespace').asJSON());
    for (const b of st.blocks || []) {
      for (const l of b.lines || []) {
        const t = (l.text || '').trim();
        if (!t) continue;
        const y = Math.round(l.bbox.y);
        if (y < 75) continue;
        if (/^(代號|頁次|座號)[：:]/.test(t)) continue;
        lines.push({ p, y, x: Math.round(l.bbox.x), t });
      }
    }
  }
  lines.sort((a, b) => a.p - b.p || a.y - b.y || a.x - b.x);

  // 標記式：`12.題幹` + `A.選項`
  const out = new Map();
  let cur = null;
  for (const l of lines) {
    const mq = l.t.match(/^(\d{1,3})\s*[.．、]\s*(.+)$/);
    const mo = l.t.match(/^([A-D])\s*[.．、]\s*(.*)$/);
    if (mq && !mo) { if (cur && cur.opts.length === 4) out.set(cur.num, cur.opts.slice()); cur = { num: +mq[1], opts: [] }; continue; }
    if (!cur) continue;
    if (mo) { cur.opts.push(mo[2]); continue; }
    if (cur.opts.length) cur.opts[cur.opts.length - 1] += l.t;
  }
  if (cur && cur.opts.length === 4) out.set(cur.num, cur.opts.slice());
  return out;
}

(async () => {
  const bad = JSON.parse(fs.readFileSync(path.join(DIR, '_tmp', 'explanation-mismatch.json'), 'utf8'));
  const files = {};
  for (const f of fs.readdirSync(DIR).filter(x => /^questions(-.*)?\.json$/.test(x) && !/\.bak/.test(x))) {
    const ex = f === 'questions.json' ? 'doctor1' : f.replace('questions-', '').replace('.json', '');
    const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    files[ex] = new Map(((Array.isArray(j) ? j : j.questions) || []).map(q => [String(q.id), q]));
  }

  // 依卷分組
  const papers = new Map();
  for (const b of bad) {
    const qid = b.key.split(':').slice(2).join(':');
    const q = files[b.exam] && files[b.exam].get(qid);
    if (!q || !q.exam_code) continue;
    const k = `${b.exam}|${q.exam_code}|${q.subject}`;
    if (!papers.has(k)) papers.set(k, { exam: b.exam, code: String(q.exam_code), subject: q.subject, year: q.roc_year, items: [] });
    papers.get(k).items.push({ b, q });
  }

  const res = { answerOk: [], answerWrong: [], undetermined: 0 };
  let done = 0;
  for (const p of papers.values()) {
    if (done >= LIMIT) break;
    const cands = probeCodes(p.code, p.year).filter(x => {
      const xk = keyName(x.subject), pk = keyName(p.subject);
      return xk === pk || xk.startsWith(pk) || pk.startsWith(xk);
    });
    if (!cands.length) { res.undetermined += p.items.length; continue; }

    let A = null, O = null;
    for (const cand of cands) {
      try {
        for (const t of ['M', 'S']) {
          try { A = await parseAnswerSheet(await getPdf(t, p.code, cand.c, cand.s)); } catch {}
          if (A && Object.keys(A).length) break;
        }
        O = await pdfOptions(await getPdf('Q', p.code, cand.c, cand.s));
        if (A && Object.keys(A).length && O.size) break;
      } catch {}
    }
    if (!A || !O || !O.size) { res.undetermined += p.items.length; continue; }

    for (const { b, q } of p.items) {
      done++;
      const off = A[q.number];
      const opts = O.get(+q.number);
      if (!off || !opts || !/^[A-D]$/.test(String(off).trim())) { res.undetermined++; continue; }
      const officialText = skel(opts['ABCD'.indexOf(String(off).trim())] || '');
      const ourText = skel((q.options || {})[q.answer] || '');
      if (!officialText || !ourText) { res.undetermined++; continue; }
      const same = officialText.includes(ourText) || ourText.includes(officialText);
      (same ? res.answerOk : res.answerWrong).push({
        exam: p.exam, where: `${q.roc_year}${q.session} #${q.number}`,
        ours: `${q.answer}. ${String((q.options || {})[q.answer]).slice(0, 30)}`,
        official: `${off}. ${String(opts['ABCD'.indexOf(String(off).trim())]).slice(0, 30)}`,
        key: b.key,
      });
    }
  }

  console.log(`比對 ${done} 題`);
  console.log(`  ✅ 答案正確（解說錯，可重寫解說）: ${res.answerOk.length}`);
  console.log(`  ⚠️ 答案錯（選項/字母錯位，要先修答案）: ${res.answerWrong.length}`);
  console.log(`  ？無法判定: ${res.undetermined}`);
  console.log('\n答案錯的樣本:');
  for (const x of res.answerWrong.slice(0, 8)) {
    console.log(`  [${x.exam}] ${x.where}`);
    console.log(`     我們: ${x.ours}`);
    console.log(`     官方: ${x.official}`);
  }
  fs.writeFileSync(path.join(DIR, '_tmp', 'expl-classified.json'), JSON.stringify(res, null, 2), 'utf8');
  console.log('\n分類結果已寫出 _tmp/expl-classified.json');
})();
