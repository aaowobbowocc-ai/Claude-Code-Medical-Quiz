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
      // ⚠️ 不能用 slice(1) 跳過標籤：標籤會跟第一個題號黏在一起（"題號第1題"），
      // 跳掉就少一格，配對整個錯位一格——比解析不出來更糟。
      const rowText = (row) => row.items.map(x => x.t).join('').replace(/\s/g, '');
      const spaced = (row) => row.items.map(x => x.t).join(' ').replace(/\s+/g, ' ').trim();

      // 這一列有哪些題號（閱讀順序 = x 由左到右）
      const seqNums = [...rowText(rows[i]).matchAll(/第(\d{1,3})題/g)].map(m => +m[1]);
      const zipNums = (spaced(rows[i]).replace(/^題(號|序)/, '').match(/\d{1,3}/g) || []).map(Number);
      const nums = seqNums.length >= 2 ? seqNums : zipNums;
      if (nums.length < 2) continue;

      // 答案格：每一格一個 text run。標籤有時跟第一格黏在一起（"答案Ａ"），
      // 把後面那截當成該 x 位置的答案補回去。
      const cells = ansRow.items.map(a => ({ x: a.x, t: halfWidth(a.t).trim() }));
      const glued = halfWidth(ansRow.items[0].t).replace(/^答\s*案\s*/, '').trim();
      cells.shift();
      if (glued) cells.unshift({ x: ansRow.items[0].x + 34, t: glued });
      const filled = cells.filter(c => c.t);
      if (!filled.length) continue;

      // 題號格的 x 座標（配對用）。黏成一個 run 的時候就配不到，只能靠順序。
      const numItems = rows[i].items.map(x => ({ x: x.x, n: numOf(x.t) })).filter(x => x.n !== null);
      const put = (n, t) => { out[n] = String(t).replace('＃', '#').trim(); };

      // ① 格數與題號數一樣 -> 照 x 由左到右對齊。
      //    複選題的答案是「AD」「ABCE」這種多字母，一格就是一題，所以這條最可靠。
      if (filled.length === nums.length) {
        // 有 x 座標的話順便驗一下真的對齊（避免中間空格剛好湊成一樣的格數）
        const aligned = numItems.length !== nums.length
          || numItems.every((ni, k) => Math.abs(filled[k].x - ni.x) <= 40);
        if (aligned) { nums.forEach((n, k) => put(n, filled[k].t)); continue; }
      }

      // ② 整列答案黏成一格（"答案BBACCCACAC"）-> 一個字母一題。
      //    ⚠️ 只在**全部都是單字母**湊得剛好時才成立；複選題黏成一格
      //    （"BEBDCDACEABC"）切不開，寧可不配也不要配錯。
      if (filled.length === 1 && /^[A-E]+$/.test(filled[0].t) && filled[0].t.length === nums.length) {
        nums.forEach((n, k) => put(n, filled[0].t[k]));
        continue;
      }

      // ③ 格數比題號少（後段留白、或整卷題數不滿一列）-> 每一格認最近的題號。
      //    ⚠️ 題號格與答案格的 x 會差 6~15px 而且**每一列差得不一樣**，
      //    所以不能用固定的小容差去框，要取最近的那一個。
      if (numItems.length === nums.length && filled.length < nums.length) {
        const used = new Set();
        let ok = 0;
        for (const c of filled) {
          let best = null;
          for (const ni of numItems) {
            if (used.has(ni.n)) continue;
            const d = Math.abs(ni.x - c.x);
            if (d <= 30 && (!best || d < best.d)) best = { d, n: ni.n };
          }
          if (best) { used.add(best.n); put(best.n, c.t); ok++; }
        }
        if (ok) continue;
      }

      /*
       * ④ 第三種版型（99 年的更正卷）：一列被切成好幾段 text run，每段塞好幾格，
       * 而且兩列的切法不一樣：
       *   題序列 ["題序 01 02 03 04 05", "06 07 08 09 10", …]
       *   答案列 ["答案 B D A", "#", "A", "D B B C A", …]
       * 段落邊界對不起來，所以前面幾條都失敗（醫師一階 99-2 醫學(二) 實測 0 筆）。
       * 但同一列的閱讀順序必然對應，數量一致就按順序配。
       * ⚠️ 要用**空白**把 run 接起來，直接 join('') 會把「01」「02」黏成「0102」。
       * ⚠️ 而且只有**每一格都是單字母**時才能這樣拆：複選題的「BE」會被拆成
       *   B、E 兩格，湊巧湊成一樣的格數就整列錯位（2026-11-27 的 E 漏字 bug）。
       */
      const toks = halfWidth(spaced(ansRow)).replace(/^答\s*案/, '').match(/[A-E#＃]+/g) || [];
      if (toks.length === nums.length && toks.every(t => t.length === 1)
        && nums.every((n, k) => k === 0 || n === nums[k - 1] + 1)) {
        nums.forEach((n, k) => put(n, toks[k]));
      }
    }
  }
  return out;
}

module.exports = { parseAnswerSheet };
