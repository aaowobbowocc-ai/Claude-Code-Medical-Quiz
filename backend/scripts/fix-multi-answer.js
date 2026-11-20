#!/usr/bin/env node
/**
 * 考選部更正「某題答 X 或 Y 均給分」的題，`answer` 要寫成 "X,Y"。
 *
 * 為什麼：前端 `utils/scoring.js` 的 `isAnswerCorrect` 早就認得逗號分隔
 * （`"B,D".split(',').includes(userAnswer)`）與 `"送分"`，但題庫裡
 * **144 題只存了其中一個字母**，另一個官方也給分的答案會被判錯。
 * 2026-11-20 使用者回報物理治療師 114020 骨科 #43「B D都對」——
 * 更正卷寫的是「第43題答Ｂ或Ｄ或BD者均給分」，我們存 B，選 D 的人被扣分。
 *
 * 這些題當初標了 `isMultiAnswer: true` 與
 * `correction_note: "第43題更正為 B,D（原答案 B）"`，但 **`isMultiAnswer`
 * 前端從來沒有讀過**（全站 grep 不到），等於標了沒有用。
 * 真正生效的欄位只有 `answer`，所以把答案寫進 `answer`。
 *
 * ⚠️ 只動 `correction_note` 明確寫出多個字母的那些。
 *   「一律給分」是另一種（`answer` 要寫 "送分"），不在這支的範圍。
 *   `original_answer` 保留，要回溯看得到原本是哪一個。
 *
 *   node scripts/fix-multi-answer.js [--apply]
 */
const fs = require('fs');
const path = require('path');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const RE = /更正為\s*([A-E](?:\s*[,，、]\s*[A-E])+)/;

let total = 0;
const samples = [];
for (const f of fs.readdirSync(BK).filter(x => /^questions(-[a-z0-9-]*)?\.json$/.test(x) && !/\.bak/.test(x))) {
  const p = path.join(BK, f);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const arr = Array.isArray(raw) ? raw : raw.questions;
  let n = 0;
  for (const q of arr) {
    const note = String(q.correction_note || '');
    const m = RE.exec(note);
    if (!m) continue;
    /*
     * 註記自己會寫「第 N 題」——那個 N 必須就是這一題的題號。
     * 牙醫二階有 4 筆對不上（113090 卷二 #54 掛著「第79題更正為 B,D」），
     * 是註記被掛到別題上了。照著改會把對的答案改成別題的答案。
     */
    const nm = /第\s*(\d{1,3})\s*題/.exec(note);
    if (nm && +nm[1] !== +q.number) {
      samples.push(`⚠ ${f} ${q.exam_code} ${q.subject} #${q.number} 的註記寫的是「第${nm[1]}題」，註記掛錯題了，跳過`);
      continue;
    }
    const letters = m[1].replace(/\s/g, '').replace(/[，、]/g, ',');
    const want = [...new Set(letters.split(','))].sort().join(',');
    const cur = String(q.answer || '');
    if (cur === want) continue;
    // 現有答案必須是「官方給分名單裡的一個」—— 不是的話代表另有隱情，不要亂改
    if (!want.split(',').includes(cur)) {
      samples.push(`⚠ ${f} ${q.exam_code} #${q.number} answer=${cur} 不在更正名單 ${want} 內，跳過`);
      continue;
    }
    if (samples.length < 8) samples.push(`${f.replace('questions-', '').replace('.json', '')} ${q.exam_code} #${q.number}  ${cur} → ${want}   ${note.slice(0, 40)}`);
    if (APPLY) {
      if (!q.original_answer) q.original_answer = cur;
      q.answer = want;
    }
    n++; total++;
  }
  if (n && APPLY) fs.writeFileSync(p, JSON.stringify(raw, null, 2));
  if (n) console.log(`${f.padEnd(34)} ${n} 題`);
}
console.log(`\n${APPLY ? '已改' : '可改'} ${total} 題`);
samples.forEach(s => console.log('   ' + s));
if (!APPLY) console.log('\n(試跑；加 --apply 才寫入)');
