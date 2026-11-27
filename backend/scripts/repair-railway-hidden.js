#!/usr/bin/env node
/**
 * 把鐵路題庫裡被藏起來的壞題，用鐵路卷的版面解析從原卷重建。
 *
 * 為什麼要另外寫一支：既有的 repair-moex-quote-spill.js / repair-moex-split-stems.js
 * 走 lib/moex-one-question-rebuild.js，那支用的是**通用**的考選部解析器
 * （lib/moex-pdf-parse）。鐵路佐級的卷子版面不一樣，通用解析器對不出來，
 * 兩支腳本一律回報「認不出是哪張卷（最高命中率 0%）」而放棄 ——
 * 題目其實在卷上，而且 scrape-railway 的版面解析讀得出來。
 *
 * 2026-11-28 scrape-railway 修好三個版面壞法之後，107070 國文 45 題全解得出來，
 * 被藏起來的那些題的完整題幹也跟著回來了。
 *
 * 五道檢查全過才覆寫（就地改、id 不動）：
 *   · 題庫題幹的開頭要是原卷題幹的開頭（確認重建到的是同一題）
 *   · 選項四格（複選五格）都有字
 *   · 答案的每個字母都有對應的選項
 *   · 題幹與每一格的引號都要**平衡**（引文被截斷就是另一種壞法，不能換一種壞法）
 *   · 重建出來的題幹要比題庫現有的長（不然等於沒修）
 *
 * `image_options` 不動 —— 那是整頁圖、讓使用者看圖選 A/B/C/D 的題，本來就看得到。
 *
 *   node scripts/repair-railway-hidden.js            # 試跑
 *   node scripts/repair-railway-hidden.js --apply
 */
const fs = require('fs');
const path = require('path');
const { fetchSheet } = require('./lib/moex-paper-resolve');
const { skeleton, sameName } = require('./lib/moex-normalize');
const { atomicWriteJson } = require('./lib/atomic-write');
const S = require('./scrape-railway.js');

const BK = path.join(__dirname, '..');
const MAP = JSON.parse(fs.readFileSync(path.join(__dirname, '_railway-map.json'), 'utf8'));
const APPLY = process.argv.includes('--apply');
const nz = (t) => String(t ?? '').trim();
const count = (s, ch) => String(s || '').split(ch).length - 1;
/** 引號開得比收得多（>0）或收得比開得多（<0）都算不平衡 */
const unclosed = (t) => count(t, '「') - count(t, '」');
const bare = (t) => String(t).replace(/^鐵路/, '');

(async () => {
  const fixed = [], skipped = [];

  for (const examKey of ['admin', 'transport']) {
    const def = S.EXAMS[examKey];
    const file = path.join(BK, def.file);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = data.questions;
    const bad = arr.filter((q) => q.incomplete && q.incomplete !== 'image_options');
    if (!bad.length) continue;

    const groups = new Map();
    for (const q of bad) {
      const k = `${q.roc_year}|${q.subject}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(q);
    }

    let dirty = false;
    for (const [gk, qs] of groups) {
      const [roc, subject] = gk.split('|');
      const ym = MAP[roc];
      const cls = ym && ym[def.cKey];
      const code = cls && Object.keys(cls.subjects).find((c) =>
        sameName(cls.subjects[c], subject) || sameName(bare(cls.subjects[c]), bare(subject)));
      if (!code) { for (const q of qs) skipped.push([examKey, gk, q.number, '找不到這張卷的代號']); continue; }
      const buf = await fetchSheet('Q', ym.sessionCode, cls.c, code);
      if (!buf) { for (const q of qs) skipped.push([examKey, gk, q.number, '抓不到原卷']); continue; }
      const maxOpts = /國文/.test(subject) && +roc >= 103 ? 5 : 4;
      const parsed = S.parseQuestions(S.buildLogicalLines(await S.extractPositionedText(buf)), maxOpts);
      const byNum = new Map(parsed.map((p) => [p.number, p]));

      for (const q of qs) {
        const p = byNum.get(+q.number);
        const keys = q.is_multi ? ['A', 'B', 'C', 'D', 'E'] : ['A', 'B', 'C', 'D'];
        const reject = (r) => skipped.push([examKey, gk, q.number, `${q.incomplete} / ${r}`]);
        if (!p) { reject('原卷解不到這個題號'); continue; }
        const head = skeleton(q.question).slice(0, 20);
        if (head.length >= 10 && !skeleton(p.question).startsWith(head)) { reject('題幹開頭跟原卷對不起來'); continue; }
        if (!keys.every((k) => nz(p.options?.[k]))) { reject(`原卷重解出來選項不滿 ${keys.length} 格`); continue; }
        const a = String(q.answer || '').replace(/[^A-E]/g, '');
        if (!a) { reject('題庫沒有答案'); continue; }
        if (!a.split('').every((k) => nz(p.options[k]))) { reject(`答案 ${a} 在重解結果裡沒有選項`); continue; }
        if (unclosed(p.question) !== 0) {
          reject(unclosed(p.question) > 0 ? '重解出來的題幹引號還是沒收' : '重解出來的題幹開頭被截掉（有」沒有「）');
          continue;
        }
        if (keys.some((k) => unclosed(p.options[k]) !== 0)) { reject('重解出來的選項引號不平衡'); continue; }
        // 選項不會以收尾／連接標點開頭。開頭是「；」表示這一格的頭被切掉了、
        // 而被切掉的那段黏在上一格的尾巴（105070 事務管理 #7 的四格都是
        // 「；Y=2；Z=5 X=6」這種，真正的選項是「X=6；Y=2；Z=5」）。
        // 這種換上去等於把一種壞法換成另一種，寧可繼續藏著。
        const leaked = keys.find((k) => /^[、，。．；：）)」』？！?!,.;:%／/]/.test(nz(p.options[k])));
        if (leaked) { reject(`重解出來的選項 ${leaked} 以標點開頭（開頭被切掉、黏在上一格尾巴）`); continue; }
        if (skeleton(p.question).length <= skeleton(q.question).length) { reject('重解出來的題幹沒有比現在的長，等於沒修'); continue; }

        fixed.push({ examKey, gk, number: q.number, flag: q.incomplete, answer: q.answer,
          before: String(q.question), beforeOpts: { ...q.options }, after: p });
        if (APPLY) {
          q.question = p.question;
          q.options = { ...p.options };
          delete q.incomplete;
          dirty = true;
        }
      }
    }
    if (APPLY && dirty) { data.total = arr.length; atomicWriteJson(file, data); }
  }

  for (const f of fixed) {
    console.log(`${f.examKey} ${f.gk} #${f.number}  （${f.flag}，答案 ${f.answer}）`);
    console.log(`   舊題幹 ${JSON.stringify(f.before.replace(/\s+/g, ' ').slice(0, 72))}`);
    console.log(`   新題幹 ${JSON.stringify(String(f.after.question).replace(/\s+/g, ' ').slice(0, 72))}`);
    for (const k of Object.keys(f.after.options)) {
      const b = nz(f.beforeOpts[k]).replace(/\s+/g, ' ');
      const a = nz(f.after.options[k]).replace(/\s+/g, ' ');
      console.log(`   ${k}) ${JSON.stringify(b.slice(0, 30))}${b === a ? '  （一樣）' : ` -> ${JSON.stringify(a.slice(0, 30))}`}`);
    }
  }
  if (skipped.length) {
    console.log('\n── 沒改（繼續藏著） ──');
    for (const s of skipped) console.log(`   ${s[0]} ${s[1]} #${s[2]}  ${s[3]}`);
  }
  console.log(`\n${APPLY ? '已救回' : '可救回'} ${fixed.length} 題｜繼續藏 ${skipped.length} 題`);
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})();
