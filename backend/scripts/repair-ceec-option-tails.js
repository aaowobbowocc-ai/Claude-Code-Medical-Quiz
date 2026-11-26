#!/usr/bin/env node
/**
 * 修「選項尾巴黏著卷面雜物」—— 學測／分科最後一個選項（D 或 E）後面常被 PDF
 * 文字層接上不屬於它的東西：
 *   · 頁尾節次：「背面尚有試題」「第貳部分：非選擇題（占28分）」「114 年學測」
 *   · 圖裡的文字標籤：「照片1」「震央 學校 斷層 N 0 5 公里」「-2.0% -1.5%」
 *   · 下一題題幹裡的代號：「甲乙」「子丑卯寅」
 *   · 注釋：「乙 閫奧：幽深的山林。」
 * 使用者是真的會看到這串字的。
 *
 * 判準：把原卷切成選項片段流，整組選項唯一對到一處，其他格**完全相同**，
 * 只有最後一格是「卷上那格 ＋ 多出來的尾巴」→ 切掉尾巴。
 *
 * ⚠️ 不能單純信 PDF（見 [[project_ceec_number_errors]]）。四道閘：
 *   1. 只動**最後一格**。gsat_109 自然 #13 的 B 是「醋酸鈉（CH3COONa)」，
 *      卷上文字層只給得出「醋酸鈉（ 3」—— 題庫那格是修好的，照卷切會弄壞。
 *   2. 尾巴若以 (E) (F) 這種**選項標記**開頭，代表這題不只四五個選項
 *      （gsat_104 自然 #58 有到 (F)、學測英文 #30 是文意選填）→ 只報告不動，
 *      那要的是「拆開」不是「切掉」。
 *   3. 卷上那格看起來被**截在詞中間**（結尾是全/半形左括號、逗號、孤立的
 *      英數字；或尾巴以小寫英文字母、右括號開頭）→ 文字層壞了，不動。
 *      例外：殘渣清單（lib/ceec-tail.js 的明確標記）自己切出來的位置跟卷上
 *      一模一樣時放行 —— 兩條互相獨立的證據指到同一個切點，比版面判斷可靠。
 *      學測英文的選項是整句英文、結尾有句點，第 3 條會全擋掉，就靠這個例外。
 *   4. 切完不能跟其他選項一樣、不能變空。
 *
 *   node scripts/repair-ceec-option-tails.js            # 試跑
 *   node scripts/repair-ceec-option-tails.js --apply
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./lib/atomic-write');
const { paperSegments } = require('./lib/ceec-paper-segments');
const { cleanTail } = require('./lib/ceec-tail');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const SUBJ = {
  國文: 'zh', 國語文綜合能力測驗: 'zh', 英文: 'en', 社會: 'social', 自然: 'science',
  歷史: 'history', 地理: 'geography', 公民: 'civics', 公民與社會: 'civics',
  物理: 'physics', 化學: 'chemistry', 生物: 'biology', 數學甲: 'mathA', 數學乙: 'mathB',
};

/** 比對用的正規化：比 lib 的 nz 多管引號、各種減號／破折號、全半角、CJK 相容字 */
function cmp(s) {
  return String(s).normalize('NFKC')
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[「」『』“”‘’"']/g, '')
    .replace(/[−–—‐‑－˗]/g, '-')
    .replace(/\s+/g, '');
}
/** 卷上那格像是被截在詞中間 */
const TRUNCATED = p => /[（(［\[「〈{,，、．.]$/.test(p) || /(^|\s)[A-Za-z0-9]$/.test(p);
const CONTINUES = t => /^[a-z)）\]］]/.test(t);
const OPTMARK = t => /^[（(]\s*[A-J]\s*[)）]/.test(t);

(async () => {
  const fixed = [], split = [], skipped = {};
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

      const keys = ['A', 'B', 'C', 'D'].concat(o.E ? ['E'] : []);
      const want = keys.map(k => cmp(o[k]));
      if (want.some(w => !w)) continue;

      // 整組選項在片段流裡唯一對到一處（允許卷上是題庫的前綴）
      let at = -1, hits = 0;
      for (let i = 0; i + keys.length - 1 < S.segs.length; i++) {
        let ok = true;
        for (let n = 0; n < keys.length; n++) {
          const s = S.segs[i + n], t = cmp(s.text);
          if (s.letter !== keys[n] || !t || !(want[n].startsWith(t) || t.startsWith(want[n]))) { ok = false; break; }
        }
        if (ok) { hits++; at = i; }
      }
      if (hits !== 1) continue;

      // 只有最後一格比卷上長，其他格要**完全相同**
      const lastN = keys.length - 1;
      let others = true;
      for (let n = 0; n < lastN; n++) if (cmp(S.segs[at + n].text) !== want[n]) others = false;
      if (!others) { skip('不只最後一格對不上，不動'); continue; }

      const paper = S.segs[at + lastN].text.trim();
      const pt = cmp(paper), bt = want[lastN];
      if (bt.length <= pt.length || !bt.startsWith(pt)) continue;
      const tail = bt.slice(pt.length);

      if (OPTMARK(tail)) { split.push({ q, tail, paper }); continue; }
      // 殘渣清單獨立切到同一個位置 → 兩條證據一致，版面判斷就不必再擋
      const byJunk = cmp(cleanTail(o[keys[lastN]])) === pt;
      if (!byJunk && (TRUNCATED(paper) || CONTINUES(tail))) { skip('卷上那格像被截在詞中間，文字層壞了，不動'); continue; }

      // 用「卷上那格」的長度回頭切題庫原文（保留題庫自己的空白與修過的字）
      const K = keys[lastN];
      const orig = String(o[K]);
      let cut = -1;
      for (let i = 1; i <= orig.length; i++) if (cmp(orig.slice(0, i)) === pt) { cut = i; break; }
      if (cut < 0) { skip('切點對不回題庫原文，不動'); continue; }
      const next = orig.slice(0, cut).replace(/[\s（(［\[，,、]+$/, '').trim();
      if (!next) { skip('切完是空的，不動'); continue; }
      if (keys.some(k => k !== K && cmp(o[k]) === cmp(next))) { skip('切完會跟別的選項一樣，不動'); continue; }

      fixed.push({ q, K, before: orig, after: next, tail: orig.slice(cut).trim(), byJunk });
      if (APPLY) { o[K] = next; dirty = true; }
    }
    if (APPLY && dirty) atomicWriteJson(fp, j);
  }

  for (const r of fixed) {
    console.log(`${r.q.exam_code} ${r.q.subject} #${r.q.number} (${r.K})  切掉「${r.tail.replace(/\s+/g, ' ')}」`);
    console.log(`   → ${r.after.replace(/\s+/g, ' ').slice(0, 90)}${r.byJunk ? '   [殘渣清單也切同一處]' : ''}`);
  }
  if (split.length) {
    console.log('\n── 尾巴是「還有更多選項」，要拆不是要切（只報告）──');
    for (const r of split) console.log(`${r.q.exam_code} ${r.q.subject} #${r.q.number}  卷上「${r.paper.slice(0, 30)}」+「${r.tail.replace(/\s+/g, ' ').slice(0, 60)}」`);
  }
  console.log(`\n${APPLY ? '已切' : '可切'} ${fixed.length} 格｜要拆的 ${split.length} 題`);
  if (Object.keys(skipped).length) console.log('跳過:', JSON.stringify(skipped, null, 1));
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})();
