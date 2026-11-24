#!/usr/bin/env node
/**
 * 修「題號本身就是錯的」那一類（audit-ceec-numbers.js 報出來的）。
 *
 * 壞法的來源：scrape-ceec.js 以前會把表格或公式裡的數字當成題號 ——
 *   「3.0×10⁸ m/s」→ 第 3 題、「1 67.3 24.6 100」→ 第 1 題。
 * 而學測／分科的答案是 `answerMap[題號]`，所以題號一錯，掛上去的就是
 * **別題的答案**。題幹看起來好好的，使用者選對卻被判錯，沒有任何外顯症狀。
 *
 *   gsat_100 自然 #6  題幹「3 10 − × 2 8 . 一質點沿 x 軸作一維直線運動…」
 *                     其實是卷上的 #28，而題庫另有一筆正確的 #28（答案 D）。
 *                     這筆 #6 掛的是 #6 的答案 A —— 選 D 的人全被判錯。
 *
 * 兩種處理：
 *   1. 卷上那個題號**題庫已經有**（而且內容正確）→ 這筆是重複出來的壞紀錄。
 *      標 incomplete='wrong_question_number' 讓前端藏起來。
 *      不直接刪：留著才查得到這題曾經怎麼壞的。
 *   2. 卷上那個題號**題庫還沒有**→ 改題號，並依官方答案卷重掛答案。
 *      id 不動（id 只是字串，改了會讓收藏／回報對不到；題號本身才是壞的，
 *      所以 key 用 id —— 跟 apply-record-patch.js 同一個道理）。
 *
 *   node scripts/repair-ceec-misnumbered.js            # 試跑
 *   node scripts/repair-ceec-misnumbered.js --apply
 */
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { atomicWriteJson } = require('./lib/atomic-write');
const { paperSegments, findOptionRuns, numberBefore, nz } = require('./lib/ceec-paper-segments');
const { parseAnswers } = require('./scrape-ceec');

const BK = path.join(__dirname, '..');
const ADIR = path.join(BK, '_tmp', 'ceec-ans');
const APPLY = process.argv.includes('--apply');
const KEYS = ['A', 'B', 'C', 'D', 'E'];
const SUBJ = {
  國文: 'zh', 國語文綜合能力測驗: 'zh', 英文: 'en', 社會: 'social', 自然: 'science',
  歷史: 'history', 地理: 'geography', 公民: 'civics', 公民與社會: 'civics',
  物理: 'physics', 化學: 'chemistry', 生物: 'biology', 數學甲: 'mathA', 數學乙: 'mathB',
};

const ansCache = new Map();
async function answersOf(tag) {
  if (ansCache.has(tag)) return ansCache.get(tag);
  const p = path.join(ADIR, `${tag}.pdf`);
  if (!fs.existsSync(p)) { ansCache.set(tag, null); return null; }
  const m = parseAnswers((await pdfParse(fs.readFileSync(p))).text);
  ansCache.set(tag, m);
  return m;
}

(async () => {
  const hid = [], renum = [], skipped = {};
  const skip = r => { skipped[r] = (skipped[r] || 0) + 1; };

  for (const f of ['questions-gsat.json', 'questions-ast.json']) {
    const fp = path.join(BK, f);
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    let dirty = false;

    for (const q of arr) {
      if (q.incomplete) continue;
      const o = q.options || {};
      if (!o.A || !o.B || !o.C || !o.D) continue;
      const tag = `${q.exam_code}_${q.subject_tag || SUBJ[q.subject] || q.subject}`;
      const S = await paperSegments(tag);
      if (!S) continue;

      const keys = KEYS.filter(k => o[k]);
      const runs = findOptionRuns(S.segs, o, keys);
      if (runs.length !== 1) continue;
      const real = numberBefore(S.nums, runs[0]);
      if (real === null || real === +q.number) continue;
      // 卷上沒抓到題庫那個題號時不能下判斷（題號流有缺口會整串誤報）
      if (!S.nums.some(n => n.num === +q.number)) { skip('卷上沒抓到題庫的題號，確認不了'); continue; }

      const twin = arr.find(x => x !== q && x.exam_code === q.exam_code
        && x.subject === q.subject && +x.number === real);

      if (twin) {
        // 已經有一筆正確的，這筆是壞掉的重複
        hid.push({ q, real, twinAns: twin.answer });
        if (APPLY) { q.incomplete = 'wrong_question_number'; dirty = true; }
      } else {
        const map = await answersOf(tag);
        const na = map && map[String(real)];
        if (!na || na.length !== 1 || !'ABCDE'.includes(na)) { skip('答案卷查不到這個題號的單一答案'); continue; }
        if (!o[na]) { skip('新答案那個字母在這題沒有選項'); continue; }
        renum.push({ q, real, oldNum: +q.number, oldAns: q.answer, newAns: na });
        if (APPLY) { q.number = real; q.answer = na; dirty = true; }
      }
    }
    if (APPLY && dirty) atomicWriteJson(fp, j);
  }

  console.log('── 標成待辦（題庫已有正確的那一筆）──');
  for (const r of hid) {
    console.log(`${r.q.exam_code} ${r.q.subject} #${r.q.number} 其實是卷上 #${r.real}`);
    console.log(`   這筆的答案 ${r.q.answer}，正確那筆（#${r.real}）是 ${r.twinAns}${r.q.answer !== r.twinAns ? '  ⚠️ 答案不一樣，選對的人會被判錯' : ''}`);
    console.log(`   題幹: ${String(r.q.question).replace(/\s+/g, ' ').slice(0, 60)}`);
  }
  console.log('\n── 改題號並重掛答案（題庫還沒有那個題號）──');
  for (const r of renum) {
    console.log(`${r.q.exam_code} ${r.q.subject} #${r.oldNum} → #${r.real}   答案 ${r.oldAns} → ${r.newAns}${r.oldAns === r.newAns ? '（一樣）' : '  ⚠️ 答案也變了'}`);
    console.log(`   題幹: ${String(r.q.question).replace(/\s+/g, ' ').slice(0, 60)}`);
  }
  console.log(`\n${APPLY ? '已標' : '可標'} ${hid.length} 題｜${APPLY ? '已改' : '可改'}題號 ${renum.length} 題`);
  if (Object.keys(skipped).length) console.log('跳過:', JSON.stringify(skipped, null, 1));
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})();
