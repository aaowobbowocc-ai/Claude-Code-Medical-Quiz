#!/usr/bin/env node
/**
 * 修「題組情境被疊了好幾層」。
 *
 * 壞法：同一個題組裡的承上題，情境是**累積**上去的 ——
 *   #17 = 【題組情境】情境 ＋ 承上題A
 *   #18 = 【題組情境】【題組情境】情境 ＋ 承上題A ＋ 承上題B   ← A 是 #17 的題目
 *   #80 = 【題組情境】×4 ＋ 情境 ＋ 承上題A~D
 * 使用者讀到的是「情境＋前面三題的題目＋這一題」，而前面那幾題自己也在題庫裡。
 * 題幹有字、選項完好、答案也對，所以既有稽核一條都看不到。
 *
 * 正確形狀就是別的題組題在用的那個：【題組情境】情境 ＋ 這一題的題目。
 * 所以留第一段（情境）與最後一段（這一題），把中間那些丟掉。
 *
 * 不用下載原卷：中間每一段都要能在**同一卷、題號更小**的題裡找到
 * （那才證明它是別題的題目、不是這一題的敘述），找不到就整題不動。
 *
 *   node scripts/repair-nested-context.js [--apply]
 */
const fs = require('fs');
const path = require('path');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const MARK = '【題組情境】';
const nz = (t) => String(t == null ? '' : t).normalize('NFKC').replace(/\s+/g, '');

(async () => {
  const files = fs.readdirSync(BK).filter((f) => /^questions(-.*)?\.json$/.test(f) && !/\.bak/.test(f));
  let fixed = 0, skip = 0;
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    if (!arr) continue;
    const byPaper = {};
    for (const q of arr) (byPaper[q.exam_code + '|' + q.subject] = byPaper[q.exam_code + '|' + q.subject] || []).push(q);
    let dirty = false;
    for (const q of arr) {
      const s = String(q.question || '');
      const m = /^(?:\u3010題組情境\u3011)+/.exec(s);
      if (!m || m[0].length <= MARK.length) continue;
      const seg = s.split('\n\n');
      const tag = f.replace('questions-', '').replace('\.json', '') + ' ' + q.exam_code + ' ' + q.subject + ' #' + q.number;
      if (seg.length < 2) { console.log('  ⊘ ' + tag + '：只有一段，分不出哪段是題目'); skip++; continue; }
      const mid = seg.slice(1, -1);
      const mine = byPaper[q.exam_code + '|' + q.subject] || [];
      const unproven = mid.filter((d) => {
        const k = nz(d).slice(0, 20);
        if (k.length < 10) return true;
        return !mine.some((x) => +x.number < +q.number && nz(x.question).includes(k));
      });
      if (unproven.length) {
        console.log('  ⊘ ' + tag + '：有 ' + unproven.length + ' 段証明不了是別題的，不動');
        console.log('      ' + unproven[0].replace(/\s+/g, ' ').slice(0, 70));
        skip++; continue;
      }
      const next = MARK + seg[0].slice(m[0].length) + '\n\n' + seg[seg.length - 1];
      console.log('  ✓ ' + tag + '：' + seg.length + ' 段 → 2 段（丟掉 ' + mid.length + ' 段）');
      if (mid.length) console.log('      丟掉 ' + mid.map((d) => d.replace(/\s+/g, ' ').slice(0, 44)).join(' ｜ '));
      if (APPLY) { q.question = next; dirty = true; }
      fixed++;
    }
    if (APPLY && dirty) fs.writeFileSync(path.join(BK, f), JSON.stringify(j, null, 2) + '\n', 'utf8');
  }
  console.log('\n' + (APPLY ? '已收成兩段' : '可收成兩段') + ' ' + fixed + ' 題｜證不了保留 ' + skip);
})();
