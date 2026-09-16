/**
 * 考選部 PDF 的共用解析器 —— 單一來源。
 *
 * 這三個函式原本在 classify-answer-vs-explanation.js / scan-missing-disputed.js /
 * verify-reported-answers.js / audit-paper-answers.js 各有一份拷貝，而且不完全一樣。
 * 最貴的一次代價：更正備註的 regex 字元類別在其中一份漏了「者」「均」，
 * 於是「答Ａ或Ｂ或Ｃ或Ｄ者給分」比對不到，連續四次把正確答案判成「答案有誤」。
 * 修一處漏三處，所以收斂到這裡。
 */

const { skeleton } = require('./moex-normalize');

/** 整份 PDF 的純文字（依 PDF 順序）。用於備註、關鍵字搜尋。 */
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

/**
 * 更正卷備註：「第N題答Ｘ、Ｙ給分」/「答Ｘ或Ｙ或Ｚ者給分」/「第N題一律給分」。
 * ⚠️ 字元類別一定要含「者」「均」——考選部有「答Ａ或Ｂ或Ｃ或Ｄ**者**給分」這種寫法，
 * 漏掉就整筆比對不到，又會把正確答案判成錯誤（2026-09-15 連續踩四次）。
 * 回傳 { 題號: 'send分' | ['A','B'] }
 */
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

/**
 * 題號 → 每題的題幹骨架。用來判斷「我們這題出自哪一張卷、原本是第幾題」。
 * 走版面錨點（`12.`開頭的行）切塊，不用整份文字硬切，跨頁也不會亂。
 */
async function pdfStems(buf) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  const lines = [];
  for (let p = 0; p < doc.countPages(); p++) {
    const st = JSON.parse(doc.loadPage(p).toStructuredText('preserve-whitespace').asJSON());
    for (const b of st.blocks || []) for (const l of b.lines || []) {
      const t = (l.text || '').trim();
      if (t) lines.push({ p, y: Math.round(l.bbox.y), x: Math.round(l.bbox.x), t });
    }
  }
  lines.sort((a, b) => a.p - b.p || a.y - b.y || a.x - b.x);
  const out = new Map();
  let cur = null;
  for (const l of lines) {
    const m = l.t.match(/^(\d{1,3})\s*[.．、]\s*(.*)$/);
    if (m && !/^[A-D]\s*[.．、]/.test(l.t)) {
      if (cur) out.set(cur.num, skeleton(cur.txt));
      cur = { num: +m[1], txt: m[2] };
      continue;
    }
    if (cur) cur.txt += l.t;
  }
  if (cur) out.set(cur.num, skeleton(cur.txt));
  if (out.size >= 10) return out;

  // ── 幾何版型 fallback ────────────────────────────────────────────
  // 護理師、中醫、聽力師等不少卷的題號是**獨立一行的純數字**（沒有「.」），
  // 選項也沒有 A./B./C./D. 標記，只靠縮排區分：
  //     x52 "9"
  //     x69 "林先生是初診斷為糖尿病的病人，下列護理工作何者…"
  //     x69 "告訴林先生糖尿病飲食的重要性…"
  // 上面那套標記式解析對這種卷回傳 0~1 題，於是整個考試在對齊體檢裡變成
  // 「原卷解析不足無法判斷」——護理師 161 卷、中醫二階 96 卷都卡在這。
  // 判法：題號那一行的 x 會明顯小於內文的 x（縮排差 ~17pt），用眾數抓內文 x。
  const xs = {};
  for (const l of lines) xs[l.x] = (xs[l.x] || 0) + 1;
  const bodyX = +Object.entries(xs).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!Number.isFinite(bodyX)) return out;

  const marks = [];
  lines.forEach((l, i) => {
    if (l.x >= bodyX - 6) return;                 // 沒有縮排，不是題號
    const m = l.t.match(/^(\d{1,3})$/);           // 純數字才算
    if (!m) return;
    const n = +m[1];
    if (n < 1 || n > 200) return;
    marks.push({ num: n, i });
  });
  if (marks.length < 10) return out;

  const geo = new Map();
  for (let k = 0; k < marks.length; k++) {
    const from = marks[k].i + 1;
    const to = k + 1 < marks.length ? marks[k].i === marks[k + 1].i ? from : marks[k + 1].i : lines.length;
    const txt = lines.slice(from, to).map(l => l.t).join('');
    // 題號可能重複出現（跨頁頁首、答案卷），保留第一次
    if (!geo.has(marks[k].num) && txt) geo.set(marks[k].num, skeleton(txt));
  }
  return geo.size > out.size ? geo : out;
}

/** 題號 → 四個選項文字。標記式（A.選項）與幾何版型都試。 */
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

/**
 * 題號 → { stem, options }，題幹與選項都保留原文（只做 NFC）。
 * 補卷／重建題目時用這個，不要用 skeleton 過的 pdfStems（那是比對用的）。
 *
 * ⚠️ 選項一定要去掉「A.」開頭的標記。2026-09-15 重建藥師卷一時用了另一支
 * 解析器，2,341 個選項連「A.」一起存進題庫，前端就會顯示「A. A.mg/hr」。
 */
async function pdfQuestions(buf) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  const lines = [];
  for (let p = 0; p < doc.countPages(); p++) {
    const st = JSON.parse(doc.loadPage(p).toStructuredText('preserve-whitespace').asJSON());
    for (const b of st.blocks || []) for (const l of b.lines || []) {
      const t = (l.text || '').trim();
      if (t) lines.push({ p, y: Math.round(l.bbox.y), x: Math.round(l.bbox.x), t: t.normalize('NFC') });
    }
  }
  lines.sort((a, b) => a.p - b.p || a.y - b.y || a.x - b.x);

  const out = new Map();
  let cur = null;
  const flush = () => {
    if (cur && cur.opts.length === 4 && cur.stem.trim()) {
      out.set(cur.num, { stem: cur.stem.trim(), options: cur.opts.map(o => o.trim()) });
    }
  };
  for (const l of lines) {
    const mo = l.t.match(/^([A-D])\s*[.．、]\s*(.*)$/);
    const mq = l.t.match(/^(\d{1,3})\s*[.．、]\s*(.*)$/);
    if (mq && !mo) { flush(); cur = { num: +mq[1], stem: mq[2], opts: [] }; continue; }
    if (!cur) continue;
    if (mo) { cur.opts.push(mo[2]); continue; }
    if (cur.opts.length) cur.opts[cur.opts.length - 1] += l.t;   // 選項換行接續
    else cur.stem += l.t;                                        // 題幹換行接續
  }
  flush();
  return out;
}

module.exports = { pdfText, parseCorrections, pdfStems, pdfOptions, pdfQuestions };
