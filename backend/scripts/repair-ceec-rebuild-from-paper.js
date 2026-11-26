#!/usr/bin/env node
/**
 * 修「題號是對的，但題幹／選項是別題的」—— 照原卷把這一題重建回來。
 *
 * 跟 repair-ceec-wrong-options.js 的差別：那支只換選項，前提是題幹沒壞。
 * 這支處理題幹也壞掉的情形 —— 例如 gsat_ref 國文 #2 的題幹是**參考試卷說明
 * 文件**的內文（「命題適度納入教材內容 為考核課內學習成就…」），選項則是
 * 卷上 #5 的選項。這種紀錄從頭到尾沒有一欄是這一題的。
 *
 * 之所以修得起來，是因為那些卷子把題號印成**單獨一行**（「1.」後面什麼都
 * 沒有，題幹在下一行），pdf-parse 攤平後整個碎掉，但 mupdf 逐行讀是乾淨的。
 *
 * 判準（全部要過）：
 *   1. 題庫這組選項在卷上**完整對到另一個題號** → 證明現在這組不是這一題的。
 *   2. 卷上這一題號自己解得乾淨：題幹非空、不是作答說明或頁首頁尾、
 *      四格以上選項都非空且互不相同。
 *   3. 官方答案卷上這一題是**單一字母**，而且那個字母在卷上的選項裡有。
 *      多字母（複選題）一律不重建 —— 題庫的單選模型表示不了，改標 incomplete。
 *   4. 重建後的答案以**答案卷**為準。題庫原本存的是 answerMap[題號]，
 *      所以通常一樣；不一樣就代表題庫那筆連答案都錯過。
 *
 *   node scripts/repair-ceec-rebuild-from-paper.js            # 試跑
 *   node scripts/repair-ceec-rebuild-from-paper.js --apply
 */
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const { atomicWriteJson } = require('./lib/atomic-write');
const { paperSegments, findOptionRuns, numberBefore } = require('./lib/ceec-paper-segments');
const { stripPageFurniture } = require('./lib/ceec-page-furniture');
const { cleanTail } = require('./lib/ceec-tail');
const { parseAnswers } = require('./scrape-ceec');

const BK = path.join(__dirname, '..');
const ADIR = path.join(BK, '_tmp', 'ceec-ans');
const APPLY = process.argv.includes('--apply');
const SUBJ = {
  國文: 'zh', 國語文綜合能力測驗: 'zh', 英文: 'en', 社會: 'social', 自然: 'science',
  歷史: 'history', 地理: 'geography', 公民: 'civics', 公民與社會: 'civics',
  物理: 'physics', 化學: 'chemistry', 生物: 'biology', 數學甲: 'mathA', 數學乙: 'mathB',
};
const cmp = s => String(s).normalize('NFKC').replace(/\s+/g, '');
const NOT_A_STEM = /^\s*(說明|命題|試卷|本中心|四、考生作答)/;

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
  const rebuilt = [], hidden = [], skipped = {};
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

      // 0. 卷上這一題的選項格全是空的 → 選項本來就是**圖**（干涉圖、波形、分布圖）。
      //    這條不需要先証明現有選項屬於哪一題 —— 卷上沒文字、題庫有文字，
      //    本身就証明這組選項不是這一題的（gsat_114 自然 #25 卡著 #26 的選項，
      //    答案字母 D 等於乂數）。
      const meNum = S.nums.find(n => n.num === +q.number);
      if (meNum) {
        let blank = 0, seen = 0;
        for (let i = meNum.ord, k = 0; i < S.segs.length && k < 5; i++, k++) {
          const seg = S.segs[i];
          if (seg.letter !== 'ABCDE'[k]) break;
          seen++;
          if (!cmp(seg.text)) blank++;
        }
        if (seen >= 4 && blank === seen && Object.values(o).some(v => cmp(v).length > 4)) {
          hidden.push({ q, belongs: null, ans: '卷上那四格沒有文字', why: 'image_options' });
          if (APPLY) { q.incomplete = 'image_options'; dirty = true; }
          continue;
        }
      }

      // 1. 現在這組選項在卷上屬於別的題號
      const keys = ['A', 'B', 'C', 'D'].concat(o.E ? ['E'] : []);
      const runs = findOptionRuns(S.segs, o, keys);
      if (runs.length !== 1) continue;
      const belongs = numberBefore(S.nums, runs[0]);
      if (belongs === null || belongs === +q.number) continue;

      // 2. 卷上這一題號自己解得乾淨嗎
      const me = meNum;
      if (!me) { skip('卷上沒抓到題庫的題號'); continue; }
      // 卷上的題幹不一定拿得到：有些卷子把「參考試卷說明文件」印在題目前面，
      // 題號流的第一個「1.」落在說明文件裡，於是 stem 收到的是說明的內文。
      // 這種時候如果**題庫的題幹看起來是正常題目**，就只換選項（卷上那一輪選項
      // 本身是對的）；gsat_ref 國文 #1 正是這種：題幹「下列「」內的字，讀音前後
      // 相同的是：」正確，只有選項是卷上 #5 的。
      const paperStem = stripPageFurniture(String(me.stem || '').replace(/\s+/g, ' ').trim())[0];
      const bankStem = String(q.question || '').replace(/\s+/g, ' ').trim();
      const paperOK = paperStem && paperStem.length >= 8 && !NOT_A_STEM.test(paperStem);
      const bankOK = bankStem.length >= 8 && !NOT_A_STEM.test(bankStem);
      if (!paperOK && !bankOK) { skip('卷上跟題庫的題幹都不像題目，不動'); continue; }
      const stem = paperOK ? paperStem : bankStem;
      const keptStem = !paperOK;
      const newOpts = {};
      for (let i = me.ord, n = 0; i < S.segs.length && n < 6; i++, n++) {
        const seg = S.segs[i];
        if (seg.letter !== 'ABCDEF'[n]) break;
        const t = cleanTail(seg.text).trim();
        if (!t) break;
        newOpts[seg.letter] = t;
      }
      const nk = Object.keys(newOpts);
      if (nk.length < 4) { skip('卷上這一題的選項解不齊'); continue; }
      if (new Set(nk.map(k => cmp(newOpts[k]))).size !== nk.length) { skip('卷上這一題的選項有重複'); continue; }

      // 3. 答案卷：多字母是複選題，表示不了
      const map = await answersOf(tag);
      const na = map && map[String(q.number)];
      if (!na) { skip('答案卷查不到這個題號'); continue; }
      if (String(na).length !== 1 || !'ABCDEF'.includes(na)) {
        hidden.push({ q, belongs, ans: na, why: 'multi_answer_unsupported' });
        if (APPLY) { q.incomplete = 'multi_answer_unsupported'; dirty = true; }
        continue;
      }
      if (!newOpts[na]) { skip('答案那個字母在卷上的選項裡沒有'); continue; }

      rebuilt.push({ q, belongs, stem, newOpts, oldAns: q.answer, newAns: na, keptStem });
      if (APPLY) { q.question = stem; q.options = newOpts; q.answer = na; dirty = true; }
    }
    if (APPLY && dirty) atomicWriteJson(fp, j);
  }

  for (const r of rebuilt) {
    console.log(`${r.q.exam_code} ${r.q.subject} #${r.q.number}  （現有選項其實是卷上 #${r.belongs} 的）`);
    console.log(`   題幹 ${r.keptStem ? '（留用題庫原有的，卷上那欄收到說明文件）' : '→'} ${r.stem.slice(0, 90)}`);
    for (const k of Object.keys(r.newOpts)) console.log(`   ${k}) ${r.newOpts[k].slice(0, 70)}`);
    console.log(`   答案 ${r.oldAns} → ${r.newAns}${r.oldAns === r.newAns ? '（一樣）' : '  ⚠️ 答案也改了'}`);
  }
  if (hidden.length) {
    console.log('\n── 標成待辦（單選模型表示不了） ──');
    for (const r of hidden) console.log(`${r.q.exam_code} ${r.q.subject} #${r.q.number}  ${r.why}：${r.ans}${r.belongs ? `（現有選項其實是卷上 #${r.belongs} 的）` : ''}`);
  }
  console.log(`\n${APPLY ? '已重建' : '可重建'} ${rebuilt.length} 題｜${APPLY ? '已標' : '可標'}待辦 ${hidden.length} 題`);
  if (Object.keys(skipped).length) console.log('跳過:', JSON.stringify(skipped, null, 1));
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})();
