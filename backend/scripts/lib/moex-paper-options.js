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
        const t = l.text || ''; if (!t.trim()) continue;
        lines.push({ pg, y: l.bbox.y, x: l.bbox.x, t });
      }
    } catch { /* 這頁抽不到文字 */ }
    try { st && st.destroy(); } catch { }
    try { page && page.destroy(); } catch { }
  }
  try { doc.destroy(); } catch { }
  lines.sort((a, b) => a.pg - b.pg || a.y - b.y || a.x - b.x);
  const ok = lines.some(l => MARK[l.t[0]]);

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
  return { opts, stems, ok };
}

module.exports = { MARK, PUA_CIRCLE, decode, nz, readPaperOptions };
