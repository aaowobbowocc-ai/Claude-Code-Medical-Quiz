/**
 * 從考選部試題 PDF 讀出「每一題的四個選項首行＋題幹」。
 *
 * 由 audit-options-vs-paper.js 與 repair-options-from-paper.js 共用 ——
 * 兩邊各寫一份解析的話，稽核報出來的筆數跟修復工具認得的筆數一定會對不上
 * （rt 那次「盤點說缺 75 題、補圖工具回報 0 個候選」就是這樣來的）。
 */
const MARK = { '': 'A', '': 'B', '': 'C', '': 'D' };
const MARK_RE = /[-]/g;

// 圈號掉進私用區的那幾段。E000~E006 ＝ ①~⑦ 見 data/pua-glyph-map.json；
// E006~E009 由版面幾何定案（聽語 101110 第 8 頁兩張圖的右欄標籤連號）。
const PUA_CIRCLE = {};
for (let i = 0; i <= 9; i++) PUA_CIRCLE[String.fromCodePoint(0xe000 + i)] = String.fromCodePoint(0x2460 + i);
for (let i = 0; i <= 9; i++) PUA_CIRCLE[String.fromCodePoint(0xe0c6 + i)] = String.fromCodePoint(0x2460 + i);

/*
 * 頁首頁尾。它們在版面上自成一塊，但跨頁時會接在上一個選項後面，被續行
 * 黏成選項的一部分（警特四等 111070 英文 #20 D「…Tackling Diabetes Is Easy.
 * 代號：3401頁次：4－3」）。在收行的時候就抹掉。
 */
const FURNITURE = /代號[：:]\s*\d{3,6}|頁次[：:]\s*\d+\s*[－\-—–]\s*\d+|座號[：:]\s*_+/g;

const decode = s => {
  let t = String(s || '');
  for (const k in PUA_CIRCLE) if (t.includes(k)) t = t.split(k).join(PUA_CIRCLE[k]);
  return t;
};

/**
 * 比對用的正規化。
 * 題庫被 NFC 正規化過、原卷沒有（相容表意文字），不收 NFKC 的話整卷都對不上
 * —— 見 project_nfc_normalize。
 */
const nz = s => decode(s).normalize('NFKC')
  .replace(/[（）]/g, c => (c === '（' ? '(' : ')'))
  .replace(/[，、]/g, ',').replace(/[。]/g, '.').replace(/[：]/g, ':').replace(/[；]/g, ';')
  .replace(/[‘’′]/g, "'").replace(/[“”]/g, '"').replace(/[－–—−]/g, '-')
  // 箭頭在原卷常常是字型自己畫的符號，抽不出 Unicode；題庫這邊存著真的「→」。
  .replace(/[→⇒➔➜⟶Æ]/g, '')
  // 原卷抽不出斜線時整串會黏在一起（「Velum/soft palate」→「Velumsoftpalate」）。
  .replace(/[/\\|]/g, '')
  // 字型沒有 IPA 時會用形狀相近的符號頂替：∫(積分) 之於 ʃ。
  .replace(/[∫]/g, 'ʃ')
  /*
   * 異體字。NFKC 只收相容表意文字，收不掉「爲/為」「衆/眾」這種**不同碼位的
   * 同一個字** —— 題庫是舊解析器的對應、原卷是 mupdf 的對應，兩邊挑了不同碼位。
   * 不折的話整題四個選項全部報不符（聽力師 100090 電生理聽力學 #72 實測）。
   */
  .replace(/[爲]/g, '為').replace(/[衆]/g, '眾').replace(/[産]/g, '產')
  .replace(/[衞]/g, '衛').replace(/[麽]/g, '麼').replace(/[臺]/g, '台')
  .replace(/[裏]/g, '裡').replace(/[卽]/g, '即').replace(/[強]/g, '强')
  .replace(/\s+/g, '')
  .replace(/[\u0000-\u001f\u007f-\u009f­​-‍⁠﻿-�]/g, '');

/**
 * @param {object} mupdf  已 import 的 mupdf 模組
 * @param {Buffer} buf    試題 PDF
 * @returns {{opts:Object, stems:Object, ok:boolean}}
 *   opts[題號][A-D] = { raw, next } —— raw 是原卷那一行（去掉標記），
 *   next 說明這個選項後面緊接著什麼：'mark'（下一個選項）/'head'（下一題）/'text'（續行）。
 *   只有 next !== 'text' 時 raw 才是**完整的**選項，修復工具靠這個把關。
 */
function readPaperOptions(mupdf, buf) {
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  const lines = [];
  for (let pg = 0; pg < doc.countPages(); pg++) {
    let page = null, st = null;
    try {
      page = doc.loadPage(pg);
      st = page.toStructuredText('preserve-whitespace');
      const si = JSON.parse(st.asJSON());
      for (const b of si.blocks || []) for (const l of b.lines || []) {
        const t = (l.text || '').replace(FURNITURE, ''); if (!t.trim()) continue;
        lines.push({ pg, y: l.bbox.y, x: l.bbox.x, w: l.bbox.w || 0, t });
      }
    } catch { /* 這頁抽不到文字 */ }
    try { st && st.destroy(); } catch { }
    try { page && page.destroy(); } catch { }
  }
  try { doc.destroy(); } catch { }
  lines.sort((a, b) => a.pg - b.pg || a.y - b.y || a.x - b.x);
  const ok = lines.some(l => MARK[l.t[0]]);
  /*
   * 沒有 PUA 標記不代表這卷解析不了 —— 醫事類（醫師／牙醫／獸醫／放射師／
   * 物治／職治／呼治／中醫／心理師…）整批用的是**明示的「1.」「A.」標籤**。
   * 2026-11-16 之前這一類卷全部被當成「認不得選項標記」跳過，共 1,741 卷
   * 從來沒跟原卷對過。
   */
  if (!ok) {
    const lab = labelOptions(lines);
    if (lab) return { opts: lab.opts, stems: lab.stems, ok: true, mode: 'label' };
  }

  const opts = {}, stems = {};
  // 先把每一行切成「片段」：一行裡可能印著好幾個選項（短選項四個排同一列）。
  const seq = [];
  let cur = null, lastSolo = null;
  for (const l of lines) {
    const trimmed = l.t.trim();
    const hm = /^(\d{1,3})\s*$/.exec(trimmed) || /^(\d{1,3})\s*[.、．]/.exec(trimmed);
    if (hm && l.x < 90) {
      cur = +hm[1]; lastSolo = null;
      opts[cur] = opts[cur] || {}; stems[cur] = stems[cur] || '';
      const tail = trimmed.replace(/^\d{1,3}\s*[.、．]?\s*/, '');
      if (tail) stems[cur] += tail;
      seq.push({ kind: 'head', n: cur });
      continue;
    }
    if (!cur) continue;
    if (!MARK[l.t[0]]) {
      if (!Object.keys(opts[cur]).length) stems[cur] += l.t;
      /*
       * 續行：選項太長換行時，下一行沒有標記。只有在「上一行就只有一個選項」
       * 而且這一行的起點對得齊時才接 —— 四個選項排成一列的版型，
       * 下一行屬於誰是看不出來的，亂接會把別的選項黏進來。
       */
      else if (lastSolo && Math.abs(l.x - lastSolo.x) <= 24) {
        const o = opts[lastSolo.n] && opts[lastSolo.n][lastSolo.letter];
        /*
         * ⚠️ 不能無限接下去。最後一個選項後面若接著下一題的情境段（而那段的
         *   題號沒被認出來），整段會被黏成一個 200 多字的選項
         *   （聽語 100140「…符號產出提供服務績效，將轉介至語言治療室之個案…」）。
         *   選項換行頂多兩三行，超過就當它不是續行。
         */
        if (o && o.open && o.lines < 3 && o.fullRaw.length < 180) {
          o.fullRaw += (/[A-Za-z0-9]$/.test(o.fullRaw) && /^[A-Za-z0-9]/.test(l.t.trim()) ? ' ' : '') + l.t.trim();
          o.lines++;
        } else if (o) o.open = false;
      }
      seq.push({ kind: 'text', n: cur });
      continue;
    }
    const hits = [...l.t.matchAll(MARK_RE)];
    for (const o of Object.values(opts[cur])) o.open = false;
    for (let i = 0; i < hits.length; i++) {
      const letter = MARK[hits[i][0]];
      const from = hits[i].index + 1;
      const to = i + 1 < hits.length ? hits[i + 1].index : l.t.length;
      const raw = l.t.slice(from, to).trim();
      // 同一題同一個字母只收第一次：換頁重印或續行不覆蓋
      if (opts[cur][letter] === undefined) opts[cur][letter] = { raw, fullRaw: raw, next: null, open: hits.length === 1, lines: 0 };
      seq.push({ kind: 'mark', n: cur, letter });
    }
    lastSolo = hits.length === 1 ? { n: cur, letter: MARK[hits[0][0]], x: l.x + 1 } : null;
  }
  // 回頭標記每個選項後面接著什麼
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i];
    if (s.kind !== 'mark') continue;
    const o = opts[s.n] && opts[s.n][s.letter];
    if (!o || o.next) continue;
    const nx = seq[i + 1];
    o.next = nx ? nx.kind : 'end';
  }
  return { opts, stems, ok, mode: 'pua' };
}

/**
 * 第二種版型：明示的「1.」「A.」標籤（醫事類全部都是，見 reference_moex_parser_variants §5）。
 *
 *   x=29 y=137  "1.亨德拉病毒（Hendra virus）主要是侵犯馬的什麼系統而引起症狀？"
 *   x=37 y=152  "A.消化"
 *   x=37 y=165  "B.呼吸"
 *
 * 回 null 代表「這卷不是這個版型」，讓呼叫端照舊當成認不得 —— 寧可跳過，
 * 也不要用猜的題號去跟題庫比（題號錯位會讓整卷誤報）。
 */
function labelOptions(lines) {
  // 同一列的文字會被拆成好幾段（y 差 1~2px），先依鄰近 y 聚成列再依 x 接起來。
  // 不能用「y 除以桶寬取整」，桶邊界會從中間切開同一列。
  const sorted = [...lines].sort((a, b) => a.pg - b.pg || a.y - b.y || a.x - b.x);
  const rows = [];
  for (const l of sorted) {
    const last = rows[rows.length - 1];
    if (last && last.pg === l.pg && Math.abs(l.y - last.y) <= 3) last.runs.push(l);
    else rows.push({ pg: l.pg, y: l.y, runs: [l] });
  }
  for (const r of rows) {
    r.runs.sort((a, b) => a.x - b.x);
    r.x = r.runs[0].x;
    r.t = joinRow(r.runs);
  }
  const LETTER = /^([A-Da-d])\s*[.、．]\s*/;

  /*
   * 題號欄的 x 取眾數。選項比題號**縮排**（29→37、35→45），這條界線是
   * 唯一能擋住「題幹本身以 A. 或數字開頭」的東西。
   */
  const xh = {};
  for (const r of rows) {
    if (r.x < 90 && /^\d{1,3}\s*[.、．]/.test(r.t)) xh[Math.round(r.x)] = (xh[Math.round(r.x)] || 0) + 1;
  }
  const top = Object.entries(xh).sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < 5) return null;
  const numX = +top[0];

  const opts = {}, stems = {}, seq = [];
  let cur = null, lastN = 0, lastLetter = null;
  for (const r of rows) {
    const t = r.t.trim();
    if (!t) continue;
    /*
     * 選項很短時四個會排在同一列（「A.甲  B.乙  C.丙  D.丁」）。
     * 只認列首的標籤會讓 A 變成「甲B.乙C.丙D.丁」、B~D 整組不見。
     * 切在 **run** 上而不是切字串：同一列的四個選項本來就是四個 run，
     * 這是版面給的事實，不是從文字猜的（文字裡的「…vitamin B.」會誤切）。
     */
    const segs = [];
    for (const run of r.runs) {
      const m = LETTER.exec(run.t.trim());
      const L = m ? m[1].toUpperCase() : null;
      const follows = segs.length && segs[segs.length - 1].L
        && L === String.fromCharCode(segs[segs.length - 1].L.charCodeAt(0) + 1);
      if (L && run.x > numX + 2 && (!segs.length || follows)) segs.push({ L, runs: [run] });
      else if (segs.length) segs[segs.length - 1].runs.push(run);
      else segs.push({ L: null, runs: [run] });
    }
    let handled = false;
    for (const seg of segs) {
      if (!seg.L) {
        // 標籤前面還有一段（上一個選項的續行擠在同一列）
        if (segs.length > 1 && cur && lastLetter && opts[cur][lastLetter]) {
          const o = opts[cur][lastLetter];
          if (o.open && o.lines < 3 && o.fullRaw.length < 180) { o.fullRaw += joinRow(seg.runs).trim(); o.lines++; }
        }
        continue;
      }
      handled = true;
      if (!cur) continue;
      const L = seg.L;
      for (const o of Object.values(opts[cur])) o.open = false;
      if (opts[cur][L] === undefined) {
        const raw = joinRow(seg.runs).trim().replace(LETTER, '');
        opts[cur][L] = { raw, fullRaw: raw, next: null, open: segs.length === 1, lines: 0 };
      }
      lastLetter = L;
      seq.push({ kind: 'mark', n: cur, letter: L });
    }
    if (handled) continue;
    const nm = /^(\d{1,3})\s*[.、．]\s*(.*)$/.exec(t);
    /*
     * 題號必須**接續**。只要求「在題號欄且以數字開頭」的話，選項裡的
     * 「2.5 mg/dL」或題幹續行的數字會被當成新題，後面整批錯位
     * —— 題號錯位比少收還糟（答案會整批對到別題）。
     */
    if (nm && Math.abs(r.x - numX) <= 3 && +nm[1] > lastN && +nm[1] <= lastN + 3) {
      cur = lastN = +nm[1];
      opts[cur] = opts[cur] || {};
      stems[cur] = (stems[cur] || '') + nm[2].trim();
      lastLetter = null;
      seq.push({ kind: 'head', n: cur });
      continue;
    }
    if (!cur) continue;
    if (lastLetter) {
      const o = opts[cur][lastLetter];
      // 續行上限同 PUA 版：不然最後一個選項會把下一段情境整段黏進來
      if (o && o.open && o.lines < 3 && o.fullRaw.length < 180) {
        o.fullRaw += (/[A-Za-z0-9]$/.test(o.fullRaw) && /^[A-Za-z0-9]/.test(t) ? ' ' : '') + t;
        o.lines++;
      } else if (o) o.open = false;
    } else stems[cur] += t;
    seq.push({ kind: 'text', n: cur });
  }
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i];
    if (s.kind !== 'mark') continue;
    const o = opts[s.n] && opts[s.n][s.letter];
    if (!o || o.next) continue;
    o.next = seq[i + 1] ? seq[i + 1].kind : 'end';
  }
  // 四個選項齊全的題太少 → 判定不是這個版型，交回去當作認不得
  const full = Object.keys(opts).filter(n => Object.keys(opts[n]).length === 4).length;
  if (full < 5 || full < Object.keys(opts).length * 0.6) return null;
  return { opts, stems };
}

/**
 * 一列裡的好幾段文字接成一條。
 * 兩段**水平重疊**時後一段的開頭會重複前一段的結尾（"…renogra" + "aphy）…"
 * → renograaphy），依 bbox 判斷重疊才去重；沒重疊時英數之間要補空白，
 * 中文之間不能補（中文是在詞中間斷行的）。
 */
function joinRow(runs) {
  let out = '', prev = null;
  for (const r of runs) {
    const t = r.t.trim();
    if (!t) continue;
    if (!out) { out = t; prev = r; continue; }
    if (r.x < prev.x + prev.w) {
      let cut = 0;
      for (let k = 3; k >= 1; k--) {
        if (out.length >= k && t.length >= k && out.slice(-k) === t.slice(0, k)) { cut = k; break; }
      }
      out += t.slice(cut);
    } else {
      const gap = r.x - (prev.x + prev.w);
      const cjk = /[㐀-鿿豈-﫿]$/.test(out) && /^[㐀-鿿豈-﫿]/.test(t);
      out += (gap > 2 && !cjk ? ' ' : '') + t;
    }
    prev = r;
  }
  return out;
}

module.exports = { MARK, PUA_CIRCLE, decode, nz, readPaperOptions };
