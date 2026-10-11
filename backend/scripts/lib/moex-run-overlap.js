/**
 * 考選部 PDF 的 text run 幾何重疊消除 —— 單一來源。
 *
 * 很多卷的每一列不是一個 run，而是好幾個**互相重疊一個字**的 run：
 *
 *   x= 72 w=35  "一位26"
 *   x=102 w=63  "6 歲服役中的"      ← 開頭的「6」就是上一段的結尾
 *   x=154 w=65  "的男性，長期"       ← 開頭的「的」就是上一段的結尾
 *   x=209 w=55  "期服用胃藥"
 *   x=264 w=64  "（antacid）數"      ← x=264 == 209+55，沒有幾何重疊 → 沒有重複字
 *   x=318 w=65  "數年，某日來"
 *
 * 直接串起來會得到「一位266 歲服役中的的男性，長期期服用胃藥（antacid）數數年…」。
 * 醫師二階 103030 醫學(四) 整卷都是這樣，導致：
 *   - `pdfText` 的文字對不上我們存的題幹 → 稽核誤判成「這題不在這張卷上」
 *   - `stemHitRate` 偏低（lib/moex-paper-resolve.js 的註解說「實測同一張正確的卷
 *     命中率可能只有 19/80」，多半就是這個造成的）
 *   - `paperQuestions` 解析出「一位7 歲歲女孩」「脂漏漏性皮膚炎炎」這種題幹
 *
 * 判準是幾何的，不是猜的：只有在 `x[N+1] < x[N] + w[N]`（兩段在版面上真的疊到）
 * 時才去找重複，所以不會動到中文裡合法的疊字（漸漸、常常、高高）——
 * 那些是同一個 run 內部的字，根本不經過這裡。
 */

/** 同一列的 run（需含 x / w / t），依 x 排序後串成一行，消掉幾何重疊造成的重複字。 */
function joinRuns(parts, maxOverlap = 4) {
  const sorted = [...parts].sort((a, b) => a.x - b.x);
  let out = '';
  let prev = null;
  for (const p of sorted) {
    let t = String(p.t || '');
    if (prev && Number.isFinite(p.x) && Number.isFinite(prev.x) && Number.isFinite(prev.w)
        && p.x < prev.x + prev.w) {
      for (let k = Math.min(maxOverlap, out.length, t.length); k >= 1; k--) {
        if (out.slice(-k) === t.slice(0, k)) { t = t.slice(k); break }
      }
    }
    out += t;
    prev = p;
  }
  return out;
}

/** 把一頁的 run 依 y 分列（同列 y 差 <= tol），每列回 { y, parts, text }。 */
function rowsOf(runs, tol = 4) {
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const r of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - r.y) <= tol) last.parts.push(r);
    else rows.push({ y: r.y, parts: [r] });
  }
  for (const row of rows) row.text = joinRuns(row.parts);
  return rows;
}

/**
 * 整份 PDF 的文字，已消除 run 重疊。
 * @param {Buffer} buf
 * @param {string} flag  toStructuredText 的旗標，預設 'preserve-whitespace'
 */
async function pdfTextClean(buf, flag = 'preserve-whitespace') {
  const mupdf = await import('mupdf');
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  let all = '';
  for (let p = 0; p < doc.countPages(); p++) {
    const st = JSON.parse(doc.loadPage(p).toStructuredText(flag).asJSON());
    const runs = [];
    for (const b of st.blocks || []) {
      if (b.type && b.type !== 'text') continue;
      for (const l of b.lines || []) {
        if (!(l.text || '').trim()) continue;
        runs.push({ x: Math.round(l.bbox.x), y: Math.round(l.bbox.y), w: Math.round(l.bbox.w), t: l.text });
      }
    }
    for (const row of rowsOf(runs)) all += row.text + ' ';
  }
  return all;
}

module.exports = { joinRuns, rowsOf, pdfTextClean };
