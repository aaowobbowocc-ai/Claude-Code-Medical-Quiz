#!/usr/bin/env node
/**
 * 修「引文溢出到選項格」—— 國文那種先引一大段古文再問的題，PDF 解析把引文
 * 攔腰切斷，後半段依序塞進選項格，真正的選項被擠掉。
 *
 *   railway-admin 106070 國文 #20   答案 A
 *     題幹「…陳曰：「武王式商容之閭，席不暇暖。吾之禮賢，有何」   ← 引號沒收
 *     A「不可！」下列選項敘述正確的是：」                       ← 引文尾巴＋問句
 *   答案指著引文碎片，使用者怎麼點都不對。
 *
 * 偵測訊號：**題幹的「比」多（引號沒收），而某一格把它收掉**。
 * 這條訊號幾乎不會誤報 —— 引文只能在題幹裡收尾，收在選項裡就是溢出去了。
 * 既有稽核看不到：題幹有東西、四格都有字、也不重複。
 *
 * 修法：用同一張卷上健康的題認出原卷（lib/moex-one-question-rebuild），
 * 再從原卷重解這一題。另加身分驗證：題庫題幹的尾段要出現在原卷的題幹裡，
 * 而且重解出來的題幹與選項都要**引號平衡**（不然等於換一種壞法）。
 *
 * 修不回來的一律藏起來，不要留著：題幹的引號沒收已經證明引文被截斷，
 * 少了後半段這題本來就答不了，留在前台只會讓人白答。
 *
 *   node scripts/repair-moex-quote-spill.js            # 試跑
 *   node scripts/repair-moex-quote-spill.js --apply
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./lib/atomic-write');
const { identifyPaper, rebuildOne, applyRebuild, KEYS } = require('./lib/moex-one-question-rebuild');
const { skeleton } = require('./lib/moex-normalize');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const ONLY = (process.argv.find((a) => a.startsWith('--exam=')) || '').split('=')[1];
const MIN_HIT = 0.6;

const count = (s, ch) => (String(s || '').split(ch).length - 1);
/** 引號開得比收得多 = 這段引文還沒結束 */
const unclosed = (t) => count(t, '「') - count(t, '」');

/**
 * 題幹的引號沒收、而某一格把它收掉 -> 引文溢出到選項了。
 * 回傳收引號的那一格，沒有就回 null。
 */
function spillAt(q) {
  if (unclosed(q.question) <= 0) return null;
  const o = q.options || {};
  const hit = Object.keys(o).filter((k) => unclosed(o[k]) < 0);
  return hit.length ? hit[0] : null;
}

(async () => {
  const fixed = [], hidden = [], skipped = {};
  const skip = (r) => { skipped[r] = (skipped[r] || 0) + 1; };

  for (const f of fs.readdirSync(BK).filter((x) => /^questions(-.*)?\.json$/.test(x) && !/\.bak/.test(x))) {
    const exam = f === 'questions.json' ? 'doctor1' : f.replace(/^questions-|\.json$/g, '');
    if (ONLY && exam !== ONLY) continue;
    const fp = path.join(BK, f);
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    if (!Array.isArray(arr)) continue;

    // 自己標過的 quote_spill 也要再試一次 —— 考選部的站偶爾抓不到卷，
    // 那是當下的網路狀況，不是這題救不回來。偵測訊號是算引號、不是硬編清單，
    // 所以重跑是安全的（對照 feedback_fix_ledger_rerun 那種不能重跑的腳本）。
    const bad = arr.filter((q) => (!q.incomplete || q.incomplete === 'quote_spill') && spillAt(q));
    // 旗標要跟偵測訊號一致：標過 quote_spill 但現在已經不符合壞法的（上一輪修好了、
    // 或解析器變好了）要把旗標拿掉，不然內容是對的卻一直被藏著。
    let cleared = 0, dirty0 = false;
    for (const q of arr) {
      if (q.incomplete === 'quote_spill' && !spillAt(q)) {
        cleared++;
        if (APPLY) { delete q.incomplete; dirty0 = true; }
      }
    }
    if (cleared) console.log(`${exam}：${cleared} 題已經不符合壞法，${APPLY ? '旗標已拿掉' : '會拿掉旗標'}`);
    if (APPLY && dirty0) atomicWriteJson(fp, j);
    if (!bad.length) continue;

    const groups = new Map();
    for (const q of bad) {
      const k = `${q.exam_code}|${q.subject}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(q);
    }

    let dirty = false;
    for (const [k, qs] of groups) {
      const [code, subject] = k.split('|');
      const siblings = arr.filter((q) => String(q.exam_code) === code && q.subject === subject);
      const paper = await identifyPaper({ exam, code, subject, siblings, broken: qs });
      const bail = (reason) => {
        for (const q of qs) {
          hidden.push({ exam, q, key: spillAt(q), reason });
          if (APPLY) { q.incomplete = 'quote_spill'; dirty = true; }
        }
      };
      if (!paper) { bail('原卷抓不到或解不出題目'); continue; }
      if (paper.hit < MIN_HIT) { bail(`認不出是哪張卷（最高命中率 ${(paper.hit * 100).toFixed(0)}%）`); continue; }

      for (const q of qs) {
        const key = spillAt(q);
        // 身分驗證：題庫題幹的尾段要在原卷的題幹裡（確認重解到的是同一題）
        const tail = skeleton(q.question).slice(-14);
        const r = rebuildOne(paper, q, (stem, o) => {
          const sk = skeleton(stem);
          if (tail.length >= 8 && !sk.includes(tail)) return '原卷那一題跟題庫的題幹對不起來';
          // 引號要**平衡**，不能只檢查「沒有多開」：少了開頭的「而多一個」，
          // 表示原卷重解出來的題幹**開頭被截掉**（引文少了前半段）。
          // 那樣換上去等於把一種壞法換成另一種壞法，閱讀題照樣答不了。
          if (unclosed(stem) !== 0) return unclosed(stem) > 0
            ? '原卷重解出來的題幹，引號還是沒收'
            : '原卷重解出來的題幹，開頭被截掉（有」沒有「）';
          if (KEYS.some((x) => unclosed(o[x]) !== 0)) return '原卷重解出來的選項引號不平衡';
          return null;
        });
        if (!r.ok) {
          hidden.push({ exam, q, key, reason: r.reason });
          if (APPLY) { q.incomplete = 'quote_spill'; dirty = true; }
          continue;
        }
        fixed.push({ exam, q, key, before: String(q.question), beforeOpts: { ...q.options }, r, hit: paper.hit });
        if (APPLY) { applyRebuild(q, r); delete q.incomplete; dirty = true; }
      }
    }
    if (APPLY && dirty) atomicWriteJson(fp, j);
  }

  for (const r of fixed) {
    console.log(`${r.exam} ${r.q.exam_code} ${r.q.subject} #${r.q.number}  （認卷命中率 ${(r.hit * 100).toFixed(0)}%，引號收在 ${r.key}）`);
    console.log(`   舊題幹 ${JSON.stringify(r.before.replace(/\s+/g, ' ').slice(-60))}`);
    console.log(`   新題幹 ${JSON.stringify(r.r.stem.replace(/\s+/g, ' ').slice(-80))}`);
    for (const x of KEYS) {
      console.log(`   ${x}) ${JSON.stringify(String(r.beforeOpts[x] || '').replace(/\s+/g, ' ').slice(0, 40))} -> ${JSON.stringify(String(r.r.options[x]).replace(/\s+/g, ' ').slice(0, 40))}`);
    }
    console.log(`   答案 ${r.q.answer === r.r.answer ? r.r.answer + '（一樣）' : `${r.q.answer} -> ${r.r.answer}  ⚠️ 答案也改了`}`);
  }
  if (hidden.length) {
    console.log(`\n── 原卷救不回來，${APPLY ? '已' : '會'}標 quote_spill 藏起來 ──`);
    for (const r of hidden) console.log(`   ${r.exam} ${r.q.exam_code} ${r.q.subject} #${r.q.number}  ${r.reason}`);
  }
  console.log(`\n${APPLY ? '已修' : '可修'} ${fixed.length} 題｜${APPLY ? '已藏' : '會藏'} ${hidden.length} 題`);
  if (Object.keys(skipped).length) console.log('跳過:', JSON.stringify(skipped, null, 1));
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})();
