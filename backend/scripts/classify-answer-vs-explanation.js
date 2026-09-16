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
const { fetchPdf, buildMoexUrl } = require('./lib/pdf-fetcher');
const { parseAnswerSheet } = require('./lib/moex-answer-sheet');

/** 更正卷備註：「第N題答Ｘ、Ｙ給分」/「答Ｘ或Ｙ或Ｚ者給分」/「第N題一律給分」
 *  ⚠️ 字元類別一定要含「者」「均」——考選部有「答Ａ或Ｂ或Ｃ或Ｄ**者**給分」這種寫法，
 *  漏掉就整筆比對不到，又會把正確答案判成錯誤（2026-09-15 第四次踩到）。 */
function parseCorrections(text) {
  const out = {};
  const i = text.indexOf('備');
  const body = i >= 0 ? text.slice(i) : text;
  for (const m of body.matchAll(/第\s*(\d{1,3})\s*題\s*(一律給分|除未作答者不給分外[^，。]*|答([ＡＢＣＤA-D、，,或者均\s]+?)[者均]?給分)/g)) {
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

const DIR = path.join(__dirname, '..');
const PDF_DIR = path.join(DIR, '_tmp', 'bullet-cloze');
const UA = 'Mozilla/5.0';
const REF = 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx';
const LIMIT = process.argv.includes('--limit') ? +process.argv[process.argv.indexOf('--limit') + 1] : 40;

const { normText: norm, skeleton: skel } = require('./lib/moex-normalize');
const { resolvePaper } = require('./lib/moex-paper-resolve');

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
  if (out.size) return out;

  // 標記式抓不到 → 改用幾何版型：題號獨立一行（x<55 純數字），選項無字母標記，
  // 靠 y 分列、x 分欄還原成格子，取每題的最後 4 格當選項。
  const marks = [];
  lines.forEach((l, i) => { if (l.x < 55 && /^\d{1,3}$/.test(l.t)) marks.push({ num: +l.t, i }); });
  const GAP = 45, ROW_TOL = 8;
  for (let mi = 0; mi < marks.length; mi++) {
    const from = marks[mi].i + 1;
    const to = mi + 1 < marks.length ? marks[mi + 1].i : lines.length;
    const block = lines.slice(from, to);
    const rows = [];
    for (const l of block) {
      let r = rows.find(x => x.p === l.p && Math.abs(x.y - l.y) <= ROW_TOL);
      if (!r) { r = { p: l.p, y: l.y, items: [] }; rows.push(r); }
      r.items.push(l);
    }
    rows.sort((a, b) => a.p - b.p || a.y - b.y);
    const cells = [];
    rows.forEach((row, ri) => {
      row.items.sort((a, b) => a.x - b.x);
      let cur2 = null;
      for (const it of row.items) {
        if (cur2 && it.x - cur2.startX <= GAP) cur2.t += it.t;
        else { cur2 = { x: it.x, startX: it.x, t: it.t, row: ri }; cells.push(cur2); }
      }
    });
    cells.sort((a, b) => a.row - b.row || a.x - b.x);
    const texts = cells
      .map(c => c.t.normalize('NFC').replace(/^[-�]?\s*/, '').trim())
      .filter(Boolean);
    if (texts.length >= 4) out.set(marks[mi].num, texts.slice(-4));
  }
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
    // 一定要用 resolvePaper 而不是「名字對得上就用」：同一場次常有多個類科開同名科目
    // （獸醫師 c=314 / 獸醫佐 c=307），名字比對會抓到別人的卷，於是整卷的選項都對不上，
    // 被誤判成「答案錯」。2026-09-15 首輪 37 筆「答案錯」裡有 26 筆是這樣來的。
    const cand = await resolvePaper({ ...p, items: p.items.map(x => x.q) });
    if (!cand) { res.undetermined += p.items.length; continue; }
    // 名稱對得上、但卷裡一題都找不到我們的題幹（hitRate 0）＝那份 PDF 根本是別的考試。
    // 例如獸醫 104090 c=314 抓回來的是藥師的卷。硬比下去會整卷被判成「答案錯」。
    if (cand.unverified && !cand.hitRate) { res.undetermined += p.items.length; continue; }
    const cands = [cand];

    // 標準卷(S)拿字母，更正卷(M)只拿備註的「答X、Y給分」。
    // 不能只抓 M —— 它的答案欄是「＃」不是字母，會讓幾乎所有題都變成無法判定。
    let A = null, corr = {}, O = null;
    for (const cand of cands) {
      try {
        try { A = await parseAnswerSheet(await getPdf('S', p.code, cand.c, cand.s)); } catch {}
        try {
          const mbuf = await getPdf('M', p.code, cand.c, cand.s);
          corr = parseCorrections(await pdfText(mbuf));
        } catch {}
        O = await pdfOptions(await getPdf('Q', p.code, cand.c, cand.s));
        if (A && Object.keys(A).length && O.size) break;
      } catch {}
    }
    if (!A || !O || !O.size) { res.undetermined += p.items.length; continue; }

    for (const { b, q } of p.items) {
      done++;
      // 有更正就以更正為準：多答案或送分時，我們的答案只要在給分範圍內就算對
      const c2 = corr[q.number];
      if (c2) {
        if (c2 === '送分' || (Array.isArray(c2) && String(q.answer).split(/[,、\s]+/).filter(Boolean).every(x => c2.includes(x)))) {
          res.answerOk.push({ exam: p.exam, where: `${q.roc_year}${q.session} #${q.number}`, ours: q.answer, official: '更正給分', key: b.key });
        } else {
          res.answerWrong.push({ exam: p.exam, where: `${q.roc_year}${q.session} #${q.number}`, ours: q.answer, official: Array.isArray(c2) ? c2.join(',') : c2, key: b.key });
        }
        continue;
      }
      const off = A && A[q.number];
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
