/**
 * 克漏字題組：把文章裡「裸露的題號」標成 __N__。
 *
 * 考選部與大考中心的克漏字都是這樣印的 —— 空格處就印一個題號：
 *   「The __41__ season to visit the city of Mumbai is…」
 *   原始文字層是「The 41 season to visit…」
 * 不標的話使用者會以為是錯字，而且看不出哪一格是本題要答的。
 *
 * 兩邊都必須是空白才算。只擋「前面不是數字」會把年份切開的
 * 「In 20 10, a South Korean couple…」的 10 當成第 10 格（實測 customs 108050）。
 * 而且要依序往後找 —— 後面的空格不可能出現在前一個空格之前。
 *
 * `marked === 0` 代表這段文章裡沒有空格，那是**閱讀測驗**題組而不是克漏字，
 * 呼叫端要原文照附，不要硬標。
 *
 * 原本這支函式在 repair-english-group-items.js 與 fill-passage-context.js
 * 各有一份，2026-10-31 收斂到這裡；scrape-ceec.js 也用同一份。
 */
function markBlanks(passage, from, to) {
  // 不要用 RegExp 字面量／樣板字串組 \s —— 反斜線在多層轉義裡會被吃掉，
  // 變成 (^|s) 而靜默地一個都標不到。直接照空白切 token 比較穩。
  const parts = String(passage || '').split(' ');
  let n = 0, k = Number(from);
  if (!Number.isFinite(k) || !Number.isFinite(Number(to))) return { text: String(passage || ''), marked: 0 };
  for (let i = 0; i < parts.length && k <= Number(to); i++) {
    if (parts[i] === String(k)) { parts[i] = `__${k}__`; k++; n++; }
  }
  return { text: parts.join(' '), marked: n };
}

/**
 * 題組文章 → 要存進 `case_context` 的字串（前端 5 個頁面都會顯示）。
 * 克漏字加註「本題問第 N 格」，閱讀測驗不加。
 */
function passageContext({ passage, groupFrom, groupTo, num }) {
  if (!passage) return null;
  const { text, marked } = markBlanks(passage, groupFrom, groupTo);
  const which = marked ? `，本題問第 ${num} 格` : '';
  const head = (groupFrom && groupTo) ? `（第 ${groupFrom}～${groupTo} 題共用下文${which}）` : '';
  return head + (marked ? text : passage);
}

module.exports = { markBlanks, passageContext };
