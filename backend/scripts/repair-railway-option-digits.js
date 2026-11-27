#!/usr/bin/env node
/**
 * 修鐵路題庫裡「選項的數字被甩到隔壁格」的題。
 *
 * 考選部 PDF 把選項的數字用另一套字型排，文字層的 x 座標會把那個數字印在
 * **自己的選項標記左邊**，於是靠 x 切選項時整排錯開一格：
 *
 *   原卷  Ⓐ1年  Ⓑ2年  Ⓒ5年  Ⓓ7年
 *   題庫  A「1年 2」 B「年 5」 C「年 7」 D「年」      ← 四格全毀
 *
 * 嚴重度：答案字母沒變，但那一格裝的不是原卷的選項，所以**答案指到的內容是錯的**；
 * 更慘的是 D 常常只剩「年」或整格空的，答案在 D 的題直接選不到正解。
 * 既有稽核一條都看不到：題幹有東西、四格「有字」、也不重複。
 *
 * 判準（全部要成立才改）：
 *   · 題庫這一題的選項符合甩位指紋（某格以空白＋數字結尾、下一格以非數字開頭），
 *     或有空格
 *   · 用修好的 parser 重解原卷，四格都有字、也沒有甩位指紋
 *   · 題幹骨架一模一樣（確認重解到的是同一題）
 *   · 答案字母在重解結果裡有對應的選項
 *
 * 就地覆寫、id 不動。parser 的修法見 scrape-railway.js 的 retreat()。
 *
 *   node scripts/repair-railway-option-digits.js            # 試跑
 *   node scripts/repair-railway-option-digits.js --apply
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
const K = ['A', 'B', 'C', 'D'];
const nz = (t) => String(t ?? '').trim();

/** 甩位／空格的指紋。沒有就回 null */
function brokenWhy(opts) {
  if (!K.every((k) => nz(opts?.[k]))) return '有空格';
  for (let i = 0; i < 3; i++) {
    if (/\s\d+(\.\d+)?$/.test(nz(opts[K[i]])) && /^[^\d\s]/.test(nz(opts[K[i + 1]]))) return '數字甩位';
  }
  return null;
}

(async () => {
  const fixed = [], skipped = [];

  for (const examKey of ['admin', 'transport']) {
    const def = S.EXAMS[examKey];
    const file = path.join(BK, def.file);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = data.questions;
    // 複選題五格，這支只管四格的單選題
    const bad = arr.filter((q) => !q.is_multi && brokenWhy(q.options));
    if (!bad.length) continue;

    // 同一張卷的題一起處理，一張卷只抓一次
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
      if (!cls) { for (const q of qs) skipped.push([examKey, gk, q.number, '沒有這一年的場次對照']); continue; }
      const bare = (t) => String(t).replace(/^鐵路/, '');
      const code = Object.keys(cls.subjects).find((c) =>
        sameName(cls.subjects[c], subject) || sameName(bare(cls.subjects[c]), bare(subject)));
      if (!code) { for (const q of qs) skipped.push([examKey, gk, q.number, '找不到科目代號']); continue; }

      const buf = await fetchSheet('Q', ym.sessionCode, cls.c, code);
      if (!buf) { for (const q of qs) skipped.push([examKey, gk, q.number, '抓不到原卷']); continue; }
      const maxOpts = /國文/.test(subject) && +roc >= 103 ? 5 : 4;
      const parsed = S.parseQuestions(S.buildLogicalLines(await S.extractPositionedText(buf)), maxOpts);
      const byNum = new Map(parsed.map((p) => [p.number, p]));

      for (const q of qs) {
        const why = brokenWhy(q.options);
        const p = byNum.get(+q.number);
        const reject = (r) => skipped.push([examKey, gk, q.number, `${why} / ${r}`]);
        if (!p) { reject('原卷解不出這一題'); continue; }
        if (skeleton(p.question) !== skeleton(q.question)) { reject('題幹跟原卷對不起來'); continue; }
        if (brokenWhy(p.options)) { reject(`重解出來還是壞的（${brokenWhy(p.options)}）`); continue; }
        const a = String(q.answer || '').replace(/[^A-D]/g, '');
        if (a && !a.split('').every((x) => nz(p.options[x]))) { reject(`答案 ${a} 在重解結果裡沒有選項`); continue; }
        fixed.push({ examKey, gk, number: q.number, why, before: { ...q.options }, after: { ...p.options }, answer: q.answer });
        if (APPLY) { q.options = { ...p.options }; dirty = true; }
      }
    }
    if (APPLY && dirty) { data.total = arr.length; atomicWriteJson(file, data); }
  }

  for (const f of fixed) {
    console.log(`${f.examKey} ${f.gk} #${f.number}  （${f.why}，答案 ${f.answer}）`);
    for (const k of K) {
      const b = nz(f.before[k]).replace(/\s+/g, ' ');
      const a = nz(f.after[k]).replace(/\s+/g, ' ');
      console.log(`   ${k}) ${JSON.stringify(b.slice(0, 34))}${b === a ? '  （一樣）' : ` -> ${JSON.stringify(a.slice(0, 34))}`}`);
    }
  }
  if (skipped.length) {
    console.log(`\n── 沒改 ──`);
    for (const s of skipped) console.log(`   ${s[0]} ${s[1]} #${s[2]}  ${s[3]}`);
  }
  console.log(`\n${APPLY ? '已修' : '可修'} ${fixed.length} 題｜沒改 ${skipped.length} 題`);
  if (!APPLY) console.log('(試跑；加 --apply 才寫入)');
})();
