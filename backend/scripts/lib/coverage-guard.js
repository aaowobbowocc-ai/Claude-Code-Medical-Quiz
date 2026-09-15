/**
 * 涵蓋率守衛：把「安靜跳過」變成「大聲警告」。
 *
 * 這個專案八次同型事故的共同點是**程式從不報錯，只是少做事**：
 *   - 檔名 glob 不含 questions.json → 醫師一階 6,297 題從沒被處理
 *   - exam registry 沒列牙體技術師/呼吸治療/語言治療 → 那些考試補圖恆為 0
 *   - CANDIDATE_SUBJECT_CODES 漏整段 09xx → 聽力師 probe 不到卷
 *   - 更正備註 regex 字元類別漏「者」「均」→ 整類寫法比對不到
 *   - 答案卷 parser 只認「題號」不認「題序」→ 更正卷永遠回傳 0
 *   - 批次漏掉整批場次 → 728 題爭議題沒標
 * 每一次都是靠「這個數字看起來怪」才發現，沒有一次是程式喊出來的。
 *
 * 用法：
 *   const { warnZero, checkRegistryCoverage, summary } = require('./lib/coverage-guard')
 *   warnZero('speech-therapist 補圖', added, '檢查 registry 類科碼與 subject code 清單')
 *   checkRegistryCoverage(Object.keys(EXAM_REGISTRY), backendDir)
 *   process.exitCode = summary()   // 有警告就回非 0
 */

const fs = require('fs');
const path = require('path');

let warnings = 0;

/** 處理數為 0 就大聲警告。0 幾乎永遠是「沒涵蓋到」而不是「本來就沒事做」。 */
function warnZero(label, count, hint) {
  if (count > 0) return false;
  warnings++;
  console.warn(`\n⚠️  ${label}：處理 0 筆`);
  if (hint) console.warn(`    可能原因：${hint}`);
  console.warn('    0 筆通常代表「名單沒涵蓋到」而不是「沒東西要處理」，請先確認再忽略。');
  return true;
}

/** 題庫檔存在、但不在 registry 裡 → 那個考試會被整個靜默跳過 */
function checkRegistryCoverage(registryKeys, backendDir) {
  const known = new Set(registryKeys);
  const files = fs.readdirSync(backendDir)
    .filter(f => /^questions(-.*)?\.json$/.test(f) && !/\.bak/.test(f));
  const missing = [];
  for (const f of files) {
    const exam = f === 'questions.json' ? 'doctor1' : f.replace('questions-', '').replace('.json', '');
    if (!known.has(exam)) missing.push(exam);
  }
  if (missing.length) {
    warnings++;
    console.warn(`\n⚠️  有 ${missing.length} 個考試不在 registry 裡，會被整個跳過：`);
    console.warn('    ' + missing.join(' '));
    console.warn('    這正是醫師一階/牙體技術師/呼吸治療師先前從沒被處理的原因。');
  }
  return missing;
}

/** 收尾：印出警告總數，回傳建議的 exit code */
function summary() {
  if (warnings) {
    console.warn(`\n⚠️  本次共 ${warnings} 項涵蓋率警告 —— 不要當成「沒事」。`);
    return 1;
  }
  return 0;
}

module.exports = { warnZero, checkRegistryCoverage, summary };
