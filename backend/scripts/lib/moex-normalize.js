/**
 * 考選部資料的字串正規化 —— 單一來源。
 *
 * 為什麼要收斂：2026-09 這輪修復下來，幾乎每個 bug 都是同一件事——
 * 兩個「看起來一樣」的字串被判定為不等，然後程式安靜跳過：
 *
 *   中醫臨床醫學(四)   vs  中醫臨床醫學（四）（包括針灸科學）   ← 全形括號＋後綴
 *   類科               vs  「類」+「科」兩個 text run          ← PDF 排版順序
 *   題號               vs  題序                                ← 標準卷 vs 更正卷
 *   答Ｂ、Ｃ給分       vs  答Ａ或Ｂ或Ｃ或Ｄ者給分              ← 備註寫法
 *   來 (U+4F86)        vs  來 (U+F92D)                         ← CJK 相容表意文字
 *   PaO2               vs  PaO 2                               ← 下標被拆開
 *
 * 而全站有 20+ 處各自寫了略有差異的 norm/keyName/skel，語意還不一致
 * （有的 NFC、有的 NFKC、有的根本沒正規化）。改一處就漏一處。
 *
 * 規則：
 *   NFC 一律要做（消除 CJK 相容表意文字，字形相同碼位不同）。
 *   NFKC 不要用——它會把全形標點改掉，破壞與原卷一致的排版。
 */

/** 基本正規化：NFC + 去所有空白（含全形空白）。比對題幹、選項文字用這個。 */
function normText(t) {
  return String(t ?? '').normalize('NFC').replace(/[\s　]/g, '');
}

/**
 * 去標點的「骨架」。兩段文字只差標點時視為相同，用於答案文字比對。
 *
 * 這裡（也只有這裡）用 NFKC：骨架是**比對用的臨時值**，不會寫回題庫，
 * 所以可以連相容字元一起折疊——℃ vs °C、Ａ vs A、㎎ vs mg 都要算同一個東西。
 * （2026-09-15 分類器把「食物復熱中心溫度需在74℃以上」判成答案錯，
 *  真相只是我們存 °C、考選部印 ℃。）
 * 存回題庫的字串一律走 normText（NFC），絕不能用 NFKC——那會改掉全形標點排版。
 */
function skeleton(t) {
  return String(t ?? '').normalize('NFKC').replace(/[\s　]/g, '')
    .replace(/[（）()［］\[\]【】、，,。．.：:；;？?！!"'`~～－\-—–_]/g, '');
}

/**
 * 科目／類科名稱的比對鍵。去括號、頓號、空白。
 * 搭配 sameName() 使用，不要直接用 === 比。
 */
function nameKey(t) {
  return String(t ?? '').normalize('NFC').replace(/[（）()【】\[\]、，,。．.\s　]/g, '');
}

/**
 * 科目／類科名稱是否指同一件事。
 * 一定要用這個而不是 ===：我們存「中醫臨床醫學(四)」，PDF 寫
 * 「中醫臨床醫學（四）（包括針灸科學）」，嚴格相等永遠不成立。
 */
function sameName(a, b) {
  const x = nameKey(a), y = nameKey(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

/** 全形英數轉半形。答案卷有些卷印的是Ａ Ｂ Ｃ Ｄ。 */
function toHalfWidth(t) {
  return String(t ?? '').replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

/**
 * 把 PDF 的 text run 依版面還原成「閱讀順序」的行。
 * 考選部會把「類」「科」拆成兩個 run 且 baseline 差 1px，照 PDF 順序串接會變成
 * 「科：語言治療師類」。必須先按 y 分列、列內按 x 排序。
 * items: [{ y, x, t }]  →  string[]（每列一個字串）
 */
function linesByLayout(items, rowTolerance = 4) {
  const rows = [];
  for (const it of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const r = rows.find(r => Math.abs(r.y - it.y) <= rowTolerance);
    if (r) r.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }
  return rows.map(r => r.items.sort((a, b) => a.x - b.x).map(i => i.t).join(''));
}

/**
 * 判斷「兩個選項是不是同一個選項」用的鍵。
 *
 * 不要拿 skeleton() 做這件事——它把標點整個刪掉，於是「3.44 cm」與「344 cm」
 * 變成同一個鍵，好好的題被當成選項重複的壞題（audiologist 100090 #15 實測，
 * 一口氣誤判 267 題）。
 * 這裡只折疊全形／半形與空白：全形逗號 ， 會被 NFKC 折成 ,，
 * 所以「兩個選項只差一個全形逗號」那種真重複仍然抓得到，小數點則保留。
 */
function optionKey(t) {
  return String(t ?? '').normalize('NFKC').replace(/[\s　]/g, '');
}

module.exports = { normText, skeleton, nameKey, sameName, toHalfWidth, linesByLayout, optionKey };
