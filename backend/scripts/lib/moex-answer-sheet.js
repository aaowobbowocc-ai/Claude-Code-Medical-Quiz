/**
 * 解析考選部「測驗式試題標準答案」PDF。
 *
 * 版型是兩列一組的表格：
 *   題號  01  02  03  04 …     (y=197)
 *   答案   A   A   C   C …     (y=218)
 * 題號與答案靠 x 座標對齊（會差幾 px，題號 x=86 對應答案 x=89），
 * 一頁會有好幾組，每組 20 題。
 *
 * 既有的 parseAnswersColumnAware 認不得這種版型（2026-09-13 實測 46 卷解析失敗），
 * 所以另外寫一支。
 *
 * 回傳 { 題號: '答案字母' }；答案欄若是「#」或中文（送分等）原樣回傳，由呼叫端判斷。
 */

const ROW_TOL = 6;
const X_TOL = 12;

async function parseAnswerSheet(buf) {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');

  const out = {};
  for (let p = 0; p < doc.countPages(); p++) {
    const st = JSON.parse(doc.loadPage(p).toStructuredText('preserve-whitespace').asJSON());
    const items = [];
    for (const b of st.blocks || []) {
      for (const l of b.lines || []) {
        const t = (l.text || '').trim();
        if (!t) continue;
        items.push({ y: Math.round(l.bbox.y), x: Math.round(l.bbox.x), t });
      }
    }
    // 分列
    const rows = [];
    for (const it of items.sort((a, b) => a.y - b.y || a.x - b.x)) {
      let row = rows.find(r => Math.abs(r.y - it.y) <= ROW_TOL);
      if (!row) { row = { y: it.y, items: [] }; rows.push(row); }
      row.items.push(it);
    }
    rows.sort((a, b) => a.y - b.y);

    const label = (row) => (row.items[0] ? row.items[0].t.replace(/\s/g, '') : '');
    for (let i = 0; i < rows.length; i++) {
      if (!/^題號$/.test(label(rows[i]))) continue;
      // 往下找最近的「答案」列
      let ansRow = null;
      for (let j = i + 1; j < Math.min(i + 4, rows.length); j++) {
        if (/^答案$/.test(label(rows[j]))) { ansRow = rows[j]; break; }
      }
      if (!ansRow) continue;

      const nums = rows[i].items.slice(1).filter(x => /^\d{1,3}$/.test(x.t));
      const ans = ansRow.items.slice(1);
      for (const n of nums) {
        // 取 x 最接近的答案格
        let best = null;
        for (const a of ans) {
          const d = Math.abs(a.x - n.x);
          if (d <= X_TOL && (!best || d < best.d)) best = { d, t: a.t };
        }
        if (best) out[+n.t] = best.t.trim();
      }
    }
  }
  return out;
}

module.exports = { parseAnswerSheet };
