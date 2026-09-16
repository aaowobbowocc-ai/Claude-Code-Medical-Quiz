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
    // 有些卷的答案是全形字母（Ａ Ｂ Ｃ Ｄ），要轉回半形才比得出來
    const halfWidth = (t) => String(t).replace(/[Ａ-Ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

    for (let i = 0; i < rows.length; i++) {
      // ⚠️ 標準答案卷的表頭是「題號」，更正答案卷是「題序」——只認「題號」會讓
      // 更正卷永遠解析失敗、一路退回標準卷，備註裡的「答Ｘ、Ｙ給分」就永遠用不到。
      // 2026-09-14 連續三次把正確答案誤判成錯誤，根因都是這一行。
      if (!/^題(號|序)/.test(label(rows[i]))) continue;
      // 往下找最近的「答案」列。注意：標籤有時跟第一個答案黏在同一個 text run
      // （"答案Ａ"），所以不能用 /^答案$/ 精確比對。
      let ansRow = null;
      for (let j = i + 1; j < Math.min(i + 4, rows.length); j++) {
        if (/^答案/.test(label(rows[j]))) { ansRow = rows[j]; break; }
      }
      if (!ansRow) continue;

      // 題號格有兩種寫法：純數字「1」，以及「第1題」。後者若不認，nums 會是空的，
      // 整張卷解析出 0 筆（社工師 114030 等表格版型的卷都是這樣）。
      const numOf = (t) => {
        const m = String(t).replace(/\s/g, '').match(/^第?(\d{1,3})題?$/);
        return m ? +m[1] : null;
      };
      const nums = rows[i].items.slice(1)
        .map(x => ({ ...x, n: numOf(x.t) }))
        .filter(x => x.n !== null);

      // 表格版型：整列常黏成一兩個 text run（"題號第1題第2題…"、"答案BBACCCACAC"），
      // 切不出獨立的格子就配不到 x 座標。這時改成「把整列文字抽乾淨再照順序配」——
      // 題號列與答案列是同一個表格的上下兩行，順序必然對應。
      // ⚠️ 不能用 slice(1) 跳過標籤：標籤會跟第一個題號黏在一起（"題號第1題"），
      // 跳掉就少一格，配對整個錯位一格——比解析不出來更糟。
      const rowText = (row) => row.items.map(x => x.t).join('').replace(/\s/g, '');
      const seqNums = [...rowText(rows[i]).matchAll(/第(\d{1,3})題/g)].map(m => +m[1]);
      const seqAns = halfWidth(rowText(ansRow)).replace(/^答案/, '').match(/[A-D#＃]/g) || [];
      if (seqNums.length >= 2 && seqNums.length === seqAns.length) {
        seqNums.forEach((n, k) => { out[n] = seqAns[k]; });
        continue;
      }

      const ans = ansRow.items.slice(1).map(a => ({ ...a, t: halfWidth(a.t) }));
      // 「答案Ａ」這種黏在一起的，把後面那截當成該 x 位置的答案補回去
      const glued = halfWidth(ansRow.items[0].t).replace(/^答案\s*/, '');
      if (glued) ans.unshift({ x: ansRow.items[0].x + 34, t: glued });

      for (const n of nums) {
        // 取 x 最接近的答案格
        let best = null;
        for (const a of ans) {
          const d = Math.abs(a.x - n.x);
          if (d <= X_TOL && (!best || d < best.d)) best = { d, t: a.t };
        }
        if (best) out[n.n] = best.t.trim();
      }
    }
  }
  return out;
}

module.exports = { parseAnswerSheet };
