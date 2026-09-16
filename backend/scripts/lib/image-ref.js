/**
 * 「這題需要看圖」的判定 —— 單一來源。
 *
 * 為什麼收斂：scan-image-deps.js 與 add-missing-images.js 各寫了一份 regex，
 * 兩份不一樣：盤點用的那份認得「下列圖」「示意圖」「箭頭所指」，補圖用的那份不認。
 * 結果是「盤點說 rt 缺 75 題，補圖工具卻回報 0 個候選」——工具沒壞，只是兩張名單不同。
 * （2026-09-15：rt 102020「下列圖形顯示病人使用的通氣模式為何？」整批漏掉的原因）
 */

const IMAGE_REF = /附圖|如圖|圖示|下圖|上圖|圖中|圖為|如下圖|如上圖|根據圖|見圖|圖所示|下列圖|示意圖|箭頭所指|箭頭|圖譜|血球如|此圖|箭號/;

/** 題幹＋選項一起看：有些卷把圖放在選項裡。 */
function needsImage(q) {
  const txt = (q.question || '') + ' ' + Object.values(q.options || {}).join(' ');
  return IMAGE_REF.test(txt);
}

module.exports = { IMAGE_REF, needsImage };
