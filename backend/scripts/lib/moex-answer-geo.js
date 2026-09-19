/**
 * 通用「測驗式試題標準答案」解析。考選部至少有四種版型：
 *   1. 題號「第1題」在上、答案在正下方
 *   2. 題號「1」在左、答案在右
 *   3. 題號列整列省略，答案全形（Ｃ）且第一個黏在「答案」標籤上 → 只能靠閱讀順序
 *   4. 答案整列黏成一個 text run（答案BBACCC…）
 * 前兩種用座標配對；配不到時退回閱讀順序，但**只有在字母數剛好等於題數時**才敢用，
 * 否則寧可回傳空的 —— 錯位的答案比沒有答案糟糕得多。
 */
const { fetchSheet } = require('./moex-paper-resolve');
const { sameName } = require('./moex-normalize');

/**
 * 舊年度（實測 100 年）的 t=S 標準答案卷會 404，但 t=A「全類科標準答案清冊」拿得到。
 * 清冊一頁一個科目：類科名稱 / 科目名稱 + 題號區間(01-10…)與答案字串(ACCCDBCADB)
 * 上下兩列、以 x 座標對齊。回傳該科目的 Map<題號, 答案>。
 *
 * ⚠️ 已知限制：t=A 回傳哪些科目由伺服器端的查詢狀態決定，直接打網址只會拿到
 * 固定的 12 頁樣本（實測重抓 8 次內容都一樣，且不含醫師一階的醫學(一)(二)）。
 * 要指定科目得先跑 wFrmExamQandASearch.aspx 的 postback 查詢流程
 * （見 reference_moex_scraper）。所以這支目前只在「要的科目剛好在樣本裡」時有用，
 * 拿不到就回 null，由 answerMap 判定為無法驗證——不要誤以為它能涵蓋所有舊年度。
 */
async function rosterMap(code, subjectName) {
  const buf = await fetchSheet('A', code, '', '');
  if (!buf) return null;
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  for (let p = 0; p < doc.countPages(); p++) {
    const st = JSON.parse(doc.loadPage(p).toStructuredText('preserve-whitespace').asJSON());
    const toks = [];
    for (const b of st.blocks || []) for (const l of b.lines || []) {
      const t = (l.text || '').trim().normalize('NFC');
      if (t) toks.push({ x: l.bbox.x, y: l.bbox.y, t });
    }
    const subj = toks.find(t => /^科目名稱[：:]/.test(t.t));
    if (!subj) continue;
    const name = subj.t.replace(/^科目名稱[：:]\s*/, '');
    if (!sameName(name, subjectName) && name !== subjectName) continue;

    const ranges = toks.filter(t => /^(\d{1,3})\s*[-－–]\s*(\d{1,3})$/.test(t.t));
    const runs = toks.filter(t => /^[A-E]{2,10}$/.test(t.t));
    const map = new Map();
    for (const r of ranges) {
      const m = /^(\d{1,3})\s*[-－–]\s*(\d{1,3})$/.exec(r.t);
      const from = +m[1];
      // 答案字串在題號區間的下一列、x 座標相近
      const run = runs.find(u => u.y > r.y && u.y - r.y < 40 && Math.abs(u.x - r.x) < 30);
      if (!run) continue;
      run.t.split('').forEach((ch, i) => map.set(from + i, ch));
    }
    if (map.size) return { map, mode: 'roster', subject: name };
  }
  return null;
}

function tokens(st, p, out) {
  for (const b of st.blocks || []) for (const l of b.lines || []) {
    let t = (l.text || '').trim().normalize('NFKC');
    if (!t) continue;
    out.push({ p, x: l.bbox.x, cx: l.bbox.x + l.bbox.w / 2, y: l.bbox.y, w: l.bbox.w, t });
  }
}

async function sheetMap(code, c, s, expected) {
  const buf = await fetchSheet('S', code, c, s);
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  const toks = [];
  for (let p = 0; p < doc.countPages(); p++)
    tokens(JSON.parse(doc.loadPage(p).toStructuredText('preserve-whitespace').asJSON()), p, toks);

  const nums = [], lets = [];
  for (const tk of toks) {
    const m = /^第(\d{1,3})題$/.exec(tk.t) || /^(\d{1,3})$/.exec(tk.t);
    if (m) { nums.push({ ...tk, n: +m[1] }); continue; }
    // 「答案Ｃ」這種黏字首的
    const g = /^(?:答案|標準答案)?\s*([A-E])$/.exec(tk.t);
    if (g) lets.push({ ...tk, t: g[1] });
    else if (/^(?:答案|標準答案)([A-E]{2,})$/.test(tk.t)) {
      // 整列黏成一串：依 x 均分不可靠，只記錄順序
      for (const ch of tk.t.replace(/^(?:答案|標準答案)/, '')) lets.push({ ...tk, t: ch, glued: true });
    }
  }

  const pair = (mode) => {
    const map = new Map(), used = new Set();
    for (const nd of nums) {
      let best = null;
      lets.forEach((lt, i) => {
        if (used.has(i) || lt.p !== nd.p || lt.glued) return;
        if (mode === 'below') {
          const dy = lt.y - nd.y; if (dy < 5 || dy > 32) return;
          const dx = Math.abs(lt.cx - nd.cx); if (dx > 22) return;
          if (!best || dx < best.dx) best = { dx, i, t: lt.t };
        } else {
          if (Math.abs(lt.y - nd.y) > 6) return;
          const dx = lt.x - (nd.x + nd.w); if (dx < -2 || dx > 60) return;
          if (!best || dx < best.dx) best = { dx, i, t: lt.t };
        }
      });
      if (best) { used.add(best.i); map.set(nd.n, best.t); }
    }
    return map;
  };

  const a = pair('below'), b = pair('right');
  let map = a.size >= b.size ? a : b, mode = a.size >= b.size ? 'below' : 'right';

  // 退回閱讀順序：字母數必須剛好等於題數，否則不用
  if (map.size < (expected || 0) * 0.9 && expected && lets.length === expected) {
    const ordered = lets.slice().sort((u, v) => u.p - v.p || u.y - v.y || u.x - v.x);
    map = new Map(ordered.map((l, i) => [i + 1, l.t]));
    mode = 'sequential';
  }
  return { map, mode, nums: nums.length, lets: lets.length };
}

/** t=S 拿不到或配對不足時，改用 t=A 清冊。舊年度（100 年）只有清冊。 */
async function answerMap(code, c, s, expected, subjectName) {
  try {
    const r = await sheetMap(code, c, s, expected);
    if (r.map.size >= (expected || 1) * 0.9) return r;
  } catch (_) { /* t=S 不存在，往下走清冊 */ }
  if (subjectName) {
    const r = await rosterMap(code, subjectName);
    if (r && r.map.size) return { ...r, nums: r.map.size, lets: r.map.size };
  }
  return { map: new Map(), mode: 'none', nums: 0, lets: 0 };
}

module.exports = { sheetMap, rosterMap, answerMap };
