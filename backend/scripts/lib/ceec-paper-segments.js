/**
 * 把大考中心（學測／分科）的試卷 PDF 拆成「選項片段流」＋「題號流」。
 *
 * 為什麼不能用「一行就是一個選項」：同一份卷會混用兩種排法
 *     (A)甲                        ← 一行一個
 *     (A) 12 cm/s   (B) 7.5 cm/s   ← 一行兩個（雙欄）
 * 所以先掃每一行、用 (X) 標記切片段，得到 A,B,C,D,E,A,B,C,D… 的片段流。
 *
 * 沒有標記的續行要併回前一段（換行的選項不然會被攔腰截斷），但**下一題的
 * 題幹同樣沒有標記**。只看標記，就會把下一題整段收進上一題的最後一個選項
 * （ast_112 物理 #11 被收進「這個新元素就以太陽的希臘文命名為氦…」）。
 * 用版面座標分辨：選項的續行會對齊或縮在選項文字之內，新題目則退回左邊界。
 *
 * 題號流 `nums` 記下每個「N.」出現時片段流的長度，用來反查某一段選項屬於第幾題
 * —— 學測／分科的答案是用**題號**去答案卷查的，題號錯＝答案錯，所以這是
 * 交叉驗證時最關鍵的一條線（見 [[project_ceec_coverage]]）。
 */
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', '..', '_tmp', 'ceec-pdf');
const MARK = /[（(]\s*([A-J])\s*[)）]/g;
// ⚠️ `(?![0-9])` 不能省：115 分科物理 #5 的題幹有「（光速 3.0 10⁸ m/s）」，
//    「3.0」會被當成第 3 題。答案是用題號去答案卷查的，題號錯＝答案錯。
const QNUM = /^\s*(\d{1,2})\s*[.．](?![0-9])\s*\S/;

const nz = s => String(s).replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')');
/** 互為前綴就算對上（題庫可能已經把尾巴的殘渣剪過） */
const pref = (x, y) => x.length > 0 && y.length > 0 && (x.startsWith(y) || y.startsWith(x));

let mupdf;
const cache = new Map();

/** @returns {Promise<{segs: Array, nums: Array}|null>} 沒有這份 PDF 回 null */
async function paperSegments(tag, dir = CACHE_DIR) {
  const key = `${dir}|${tag}`;
  if (cache.has(key)) return cache.get(key);
  const p = path.join(dir, `${tag}.pdf`);
  if (!fs.existsSync(p)) { cache.set(key, null); return null; }
  mupdf = mupdf || await import('mupdf');
  const doc = mupdf.Document.openDocument(fs.readFileSync(p), 'application/pdf');
  const segs = [], nums = [];
  // 正在收題幹的那個題號。碰到第一個 (X) 標記就停 —— 題幹只到選項開始為止。
  let openNum = null;
  for (let i = 0; i < doc.countPages(); i++) {
    const st = JSON.parse(doc.loadPage(i).toStructuredText('preserve-whitespace').asJSON());
    for (const b of st.blocks || []) for (const l of b.lines || []) {
      const line = String(l.text || '');
      const x = (l.bbox && l.bbox.x) || 0;
      // 題號在一份卷裡只會遞增。比前一個小或相等的不收 —— 頁尾的「- 12 -」、
      // 圖說裡的「1.」「2.」都會被這條擋掉。
      const qm = line.match(QNUM);
      const lastNum = nums.length ? nums[nums.length - 1].num : 0;
      if (qm && +qm[1] > lastNum) {
        openNum = { num: +qm[1], ord: segs.length, stem: line.replace(QNUM, '').slice(0, 0) + line.replace(/^\s*\d{1,2}\s*[.．]\s*/, '') };
        nums.push(openNum);
      }
      MARK.lastIndex = 0;
      const hits = [...line.matchAll(MARK)];
      if (!hits.length) {
        // 題幹常跨好幾行，收到第一個選項標記為止
        if (openNum && !qm) openNum.stem += line;
        const last = segs[segs.length - 1];
        if (!last || last.closed) continue;
        if (qm || x + 2 < last.x) { last.closed = true; continue; }
        last.text += ' ' + line;
        continue;
      }
      if (openNum) { openNum.stem += line.slice(0, hits[0].index); openNum = null; }
      for (let h = 0; h < hits.length; h++) {
        const from = hits[h].index + hits[h][0].length;
        const to = h + 1 < hits.length ? hits[h + 1].index : line.length;
        segs.push({ letter: hits[h][1], text: line.slice(from, to), x });
      }
    }
  }
  const out = { segs, nums };
  cache.set(key, out);
  return out;
}

/**
 * 在片段流裡找「連續相鄰、每格都對得上」的選項段。
 * @returns 所有命中的起始位置。兩處以上代表卷上有題目選項長得一樣，無法確認。
 */
function findOptionRuns(segs, options, keys) {
  const want = keys.map(k => nz(options[k]));
  if (want.some(s => !s)) return [];
  const hits = [];
  for (let i = 0; i + keys.length - 1 < segs.length; i++) {
    let good = true;
    for (let n = 0; n < keys.length; n++) {
      const s = segs[i + n];
      if (s.letter !== keys[n] || !pref(nz(s.text), want[n])) { good = false; break; }
    }
    if (good) hits.push(i);
  }
  return hits;
}

/**
 * 這段選項之前最後出現的題號。分不出來時回 null。
 *
 * ⚠️ 有些卷（參考試卷英文）是雙欄排版，PDF 的閱讀順序把好幾題的題幹先排完
 *    才排選項，於是 1.、2.、3.、4. 四個題號**落在同一個位置**。這時「最後
 *    出現的那個」會固定選到 4，把 #1~#3 全報成錯的。擠在一起就代表這份卷的
 *    題號流在這裡沒有解析度，要說不知道，不能猜。
 */
function numberBefore(nums, ord) {
  let k = -1;
  for (let i = nums.length - 1; i >= 0; i--) if (nums[i].ord <= ord) { k = i; break; }
  if (k < 0) return null;
  const at = nums[k].ord;
  if ((k > 0 && nums[k - 1].ord === at) || (k + 1 < nums.length && nums[k + 1].ord === at)) return null;
  return nums[k].num;
}

module.exports = { paperSegments, findOptionRuns, numberBefore, nz, pref };
