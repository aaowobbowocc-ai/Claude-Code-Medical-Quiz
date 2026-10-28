/*
 * Adobe Symbol 字型編碼表：U+F020–U+F0FF → 真正的 Unicode。
 *
 * PDF 裡用 Symbol 字型排的數學符號，字型子集沒有 ToUnicode 對應時
 * 會整批掉進私用區 U+F0xx，對應關係就是 Symbol 的 0x20–0xFF。
 * 在網頁上會渲染成豆腐字。
 *
 * 2026-10-27 第一次在公衛師 111110 生物統計學 #17 發現：
 *   「標準化隨機樣本(X 〔F02D〕〔F06D〕)/〔F073〕i」
 * 而同一題題幹寫「平均值為μ且標準差為σ」用的是真的 μ、σ
 * —— 0x2D=minus、0x6D（'m' 的位置）=mu、0x73（'s'）=sigma，完全吻合。
 * 當時是一個一個加進 pua-glyph-map.json；2026-10-28 補學測題文時
 * 又冒出 12 個新碼位，才改成整張表。
 *
 * ⚠️ 有一群是**排版用的分段字元**（多行大括號／長箭頭的中段），
 *    在攤平的純文字裡沒有意義，對應到空字串＝刪掉。
 */

// 0x20–0x7E
const LOW =
  ' !∀#∃%&∋()∗+,−./0123456789:;<=>?' +
  '≅ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ[∴]⊥_' +
  '‾αβχδεφγηιϕκλμνοπθρστυϖωξψζ{|}∼'

// 0xA0–0xFF（0x7F–0x9F 沒有定義）
const HIGH =
  '€ϒ′≤⁄∞ƒ♣♦♥♠↔←↑→↓' +          // A0–AF
  '°±″≥×∝∂•÷≠≡≈…\u0000\u0000↵' + // B0–BF（BD arrowvertex / BE arrowhorizex 是分段字元）
  'ℵℑℜ℘⊗⊕∅∩∪⊃⊇⊄⊂⊆∈∉' +          // C0–CF
  '∠∇®©™∏√⋅¬∧∨⇔⇐⇑⇒⇓' +          // D0–DF
  '◊⟨®©™∑\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000' + // E0–EF（E6–EF 括號分段）
  '\u0000⟩∫\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000'  // F0–FF（F3–F5 積分分段、F6–FB 括號分段）

/** U+F0xx → 字元；排版分段字元回 ''；不在表內回 null。 */
function symbolChar(cp) {
  if (cp < 0xF020 || cp > 0xF0FF) return null
  const b = cp - 0xF000
  let ch = null
  if (b >= 0x20 && b <= 0x7E) ch = LOW[b - 0x20]
  else if (b >= 0xA0) ch = HIGH[b - 0xA0]
  if (ch === undefined || ch === null) return null
  return ch === '\u0000' ? '' : ch      // \0 = 排版分段字元，刪掉
}

/** 把字串裡所有 Symbol 字型的 PUA 換掉。回傳 [結果, 換了幾個]。 */
function decodeSymbolFont(s) {
  let n = 0
  const out = String(s || '').replace(/[-]/g, m => {
    const c = symbolChar(m.codePointAt(0))
    if (c === null) return m
    n++
    return c
  })
  return [out, n]
}

module.exports = { symbolChar, decodeSymbolFont }
