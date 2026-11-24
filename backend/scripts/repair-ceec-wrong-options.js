#!/usr/bin/env node
/**
 * 修「題幹是這一題的、選項卻整組是別題的」。
 *
 * audit-ceec-numbers.js 用原卷上的選項反查題號，抓到一批題庫題號與卷上題號
 * 對不上的題。其中一類是：**題幹對得上題庫的題號，選項卻屬於另一題**。
 *
 *   gsat_102 社會 #10
 *     題幹「某內閣制國家，有甲乙丙丁戊五個政黨…聯合內閣組成之敘述何者正確？」
 *     選項 (A)「臺北直飛上海航班採以價制量導致需求大於供給」   ← 卷上 #15 的選項
 *
 * 使用者看到的是正確的題目配一組不相干的選項，答案字母等於亂數 ——
 * 而題幹好好的，既有的稽核（選項重複、整格比對、健康報告）一條都看不到。
 *
 * 修法：題號與題幹兩邊都指向同一題，所以**答案是對的**，只要照原卷把那一題的
 * 選項整組補回來。從卷上「N.」那一行之後取連續的 (A)(B)(C)(D)[(E)] 片段。
 *
 * 會擋下來的狀況：
 *   · 卷上找不到這個題號、或題號之後不是從 (A) 開始連續排下來
 *   · 題幹與卷上那一題對不起來（那就不只是選項錯，屬於整題錯位，不在這裡處理）
 *   · 補出來的選項有重複、或答案那個字母補不出來
 *   · 補出來的跟題庫現有的一樣（那表示根本沒錯，是稽核誤報）
 *
 *   node scripts/repair-ceec-wrong-options.js            # 試跑（印新舊並排）
 *   node scripts/repair-ceec-wrong-options.js --apply
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./lib/atomic-write');
const { paperSegments, findOptionRuns, numberBefore, nz } = require('./lib/ceec-paper-segments');
const { cleanTail } = require('./lib/ceec-tail');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const ONLY = arg('exam');

const SUBJ = {
  國文: 'zh', 國語文綜合能力測驗: 'zh', 英文: 'en', 社會: 'social', 自然: 'science',
  歷史: 'history', 地理: 'geography', 公民: 'civics', 公民與社會: 'civics',
  物理: 'physics', 化學: 'chemistry', 生物: 'biology', 數學甲: 'mathA', 數學乙: 'mathB',
};
const KEYS = ['A', 'B', 'C', 'D', 'E'];

(async () => {
  const fixed = [], skipped = {};
  const skip = r => { skipped[r] = (skipped[r] || 0) + 1; };

  for (const f of ['questions-gsat.json', 'questions-ast.json']) {
    const fp = path.join(BK, f);
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    let dirty = false;

    for (const q of arr) {
      if (ONLY && !String(q.exam_code).startsWith(ONLY)) continue;
      const o = q.options || {};
      if (!o.A || !o.B || !o.C || !o.D) continue;
      const tag = `${q.exam_code}_${q.subject_tag || SUBJ[q.subject] || q.subject}`;
      const S = await paperSegments(tag);
      if (!S) continue;

      // 卷上這個題號在哪
      const hit = S.nums.filter(n => n.num === +q.number);
      if (hit.length !== 1) { continue; }
      const ord = hit[0].ord;

      // 題號之後要從 (A) 開始連續排。排不出來就不是這支處理的對象。
      const got = {};
      for (let n = 0; n < 5; n++) {
        const s = S.segs[ord + n];
        if (!s || s.letter !== KEYS[n]) break;
        got[KEYS[n]] = cleanTail(s.text).replace(/\s+/g, ' ').trim();
      }
      // 切出來是空的那一格要丟掉，不要留成 E:""。
      // ast_113 生物的單選題只有四個選項，卷上那個 (E) 是下一題的開頭。
      for (const k of KEYS) if (got[k] !== undefined && !String(got[k]).trim()) delete got[k];
      if (!got.A || !got.B || !got.C || !got.D) { continue; }

      // ── 只動「選項證明屬於別題」的 ──
      // 不能用「題庫的選項跟卷上不一樣就覆蓋」當判準：題庫那些選項被修過很多輪
      //（PUA 換回 ε λ α β、下標歸位、控制字元清掉…），而 PDF 文字層本來就
      // 給不出那些字。照卷覆蓋會把修好的再弄壞一次
      //（ast_115 物理 #10 的「一次 α 衰變」會變回「一次衰變」）。
      // 真正的判準是：題庫現有的這組選項，在卷上**完整對到另一個題號**底下 ——
      // 那就證明它整組是別題的，不是這一題的（見 [[procedure_port_repair_into_parser]]
      // 的「別把題庫當 ground truth」，反過來也成立：別把 PDF 當 ground truth）。
      const bankKeys = KEYS.filter(k => o[k]);
      const runs = findOptionRuns(S.segs, o, bankKeys);
      if (runs.length !== 1) { skip('題庫這組選項在卷上定位不到（或有多處），不動'); continue; }
      const belongsTo = numberBefore(S.nums, runs[0]);
      if (belongsTo === null || belongsTo === +q.number) { skip('選項本來就是這一題的'); continue; }

      // 只有在**題幹對得上卷上這一題**時才動手：題號與題幹都指向同一題，
      // 證明答案是對的，錯的只有選項。
      const stemKey = nz(q.question).slice(0, 16);
      const paperStem = nz(hit[0].stem || '');
      const stemOk = stemKey.length >= 8 && paperStem.includes(stemKey);
      if (!stemOk) { skip('題幹與卷上那一題對不起來（整題錯位，不在這裡處理）'); continue; }

      const vals = KEYS.filter(k => got[k]).map(k => nz(got[k]));
      if (new Set(vals).size < vals.length) { skip('卷上切出來的選項有重複'); continue; }
      if (!got[q.answer]) { skip('答案那個字母補不出來'); continue; }
      if (vals.some(v => v.length < 1)) { skip('有一格是空的'); continue; }

      fixed.push({ q, old: { ...o }, got: { ...got }, belongsTo });
      if (APPLY) { q.options = { ...got }; dirty = true; }
    }
    if (APPLY && dirty) atomicWriteJson(fp, j);
  }

  for (const r of fixed) {
    console.log(`\n── ${r.q.exam_code} ${r.q.subject} #${r.q.number}  ans=${r.q.answer}`);
    console.log(`   題幹: ${String(r.q.question).slice(0, 60)}`);
    for (const k of KEYS) {
      if (!r.old[k] && !r.got[k]) continue;
      console.log(`   ${k} 舊 ${JSON.stringify(String(r.old[k] ?? '').slice(0, 56))}`);
      console.log(`     ${' '.repeat(1)}新 ${JSON.stringify(String(r.got[k] ?? '').slice(0, 56))}`);
    }
  }
  console.log(`\n${APPLY ? '已修' : '可修'} ${fixed.length} 題`);
  if (Object.keys(skipped).length) console.log('跳過:', JSON.stringify(skipped, null, 1));
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})();
