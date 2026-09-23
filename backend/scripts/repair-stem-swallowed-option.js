#!/usr/bin/env node
/**
 * 修「選項 A 被吃進題幹、其餘選項整組上移」。
 *
 *   題幹  市政府徵收私有土地…下列何者非屬合法通知之方式？市政府只張貼函文在主管機關公布欄
 *   (A) 市政府以掛號郵寄函文至本人住居所      ← 其實是原卷的 B
 *   (B) 郵寄送達函文由本人同居配偶簽收        ← 原卷的 C
 *   (C) 郵寄送達處所2 次無人應答時，將函文…   ← 原卷的 D 前半
 *   (D) 入送達處所信箱                        ← 原卷的 D 後半
 *
 * 使用者回報 #938 的原話：「A選項跑到題目上面了，導致選項A寫的是選項B的內容」。
 *
 * 這跟 [[project_option_shift]] 記的那型**方向相反**：那型是題幹尾巴掉進選項 A
 * （選項整組下移、原卷的 D 遺失），所以 repair-shift-by-one.js 的簽章對這型無效。
 *
 * 判準：**我們的題幹 = 原卷題幹 + 多出來的字**（skeleton 前綴相符且更長）。
 * 命中就整題重建，答案改用標準答案卷——選項位置全變了，舊字母指的是錯的位置。
 *
 *   node scripts/repair-stem-swallowed-option.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper } = require('./lib/moex-paper-resolve');
const { paperQuestions } = require('./fill-civil-gaps');
const { sheetMap } = require('./lib/moex-answer-geo');
const { skeleton, optionKey } = require('./lib/moex-normalize');
const { atomicWriteJson } = require('./lib/atomic-write');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const PUA = /[-]/;
// 最後一個選項後面常常緊接著下一段題組的宣告，會被一起收進選項 D
// （customs 105050 英文 #5 的 D 變成「substitute請依下文回答第6題至第10題」）
const DECL_TAIL = /(?:請)?依下[文列]回答第\s*\d{1,3}\s*題.*$|第\s*\d{1,3}\s*題至第\s*\d{1,3}\s*題.*$/;
const optsOf = o => ['A', 'B', 'C', 'D'].map(k => String(o[k] || '').replace(DECL_TAIL, '').trim());
const usable = a => a.length === 4 && a.every(t => t)
  && new Set(a.map(optionKey)).size === 4 && !a.some(t => PUA.test(t));

const rows = JSON.parse(fs.readFileSync(path.join(BK, '_tmp', 'stem-tail-suspect.json'), 'utf8'))
  .filter(r => !r.f.startsWith('shared-banks'));   // 共用題庫走 sync-shared-bank-stems.js

const groups = {};
for (const r of rows) (groups[`${r.exam}|${r.code}|${r.subject}`] = groups[`${r.exam}|${r.code}|${r.subject}`] || { file: r.f, items: [] }).items.push(r);

(async () => {
  const banks = {}, fixed = [], skip = [];
  let errs = 0, done = 0;
  const keys = Object.keys(groups);
  console.log(`要查 ${keys.length} 張卷、${rows.length} 題\n`);

  for (const k of keys) {
    done++;
    const [exam, code, subject] = k.split('|');
    const file = path.join(BK, groups[k].file.replace('./', ''));
    if (!banks[file]) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      banks[file] = { raw, arr: Array.isArray(raw) ? raw : raw.questions, dirty: false };
    }
    const all = banks[file].arr.filter(q => String(q.exam_code) === code && q.subject === subject);
    let src, ans;
    try {
      const p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items: all });
      if (!p) { groups[k].items.forEach(r => skip.push({ k, n: r.n, why: '對不到官方卷' })); continue; }
      src = await paperQuestions(code, p.c, p.s);
      ans = (await sheetMap(code, p.c, p.s, all.length)).map;
    } catch (e) {
      errs++; groups[k].items.forEach(r => skip.push({ k, n: r.n, why: '原卷處理失敗: ' + e.message.slice(0, 40) }));
      continue;
    }
    for (const r of groups[k].items) {
      const q = banks[file].arr.find(x => String(x.id) === String(r.id));
      if (!q) { skip.push({ k, n: r.n, why: '題庫找不到 id' }); continue; }
      const s = src.get(+r.n);
      if (!s) { skip.push({ k, n: r.n, why: '原卷解析不到該題號' }); continue; }
      const stem = String(s.stem || '').trim();
      if (stem.length < 10 || PUA.test(stem)) { skip.push({ k, n: r.n, why: '原卷題幹不可用' }); continue; }
      const a = skeleton(q.question), b = skeleton(stem);
      // 簽章：我們的題幹是原卷題幹再接了東西
      if (!(a.startsWith(b) && a.length > b.length)) { skip.push({ k, n: r.n, why: '不符「題幹多吃了字」的簽章' }); continue; }
      const srcOpts = optsOf(s.options || {});
      if (!usable(srcOpts)) { skip.push({ k, n: r.n, why: '原卷選項不完整' }); continue; }
      // 多重答案與官方更正過的題不能用標準答案卷覆寫（那是送分／一律給分的結果，
      // 答案卷上只會有一個字母）。改用「選項文字」把舊字母對應到新位置；
      // 有任何一個字母對不到就整題跳過，寧可不修。
      const oldOpts = optsOf(q.options || {});
      const multi = /,/.test(String(q.answer)) || q.disputed;
      let official;
      if (multi) {
        const letters = String(q.answer).split(',').map(x => x.trim()).filter(Boolean);
        const mapped = letters.map(L => {
          const txt = optionKey(oldOpts['ABCD'.indexOf(L)] || '');
          if (!txt) return null;
          const i = srcOpts.findIndex(t => optionKey(t) === txt || optionKey(t).startsWith(txt) || txt.startsWith(optionKey(t)));
          return i < 0 ? null : 'ABCD'[i];
        });
        if (mapped.some(x => !x)) { skip.push({ k, n: r.n, why: '更正題的舊答案對應不到新位置' }); continue; }
        official = [...new Set(mapped)].sort().join(',');
      } else {
        official = ans.get(+r.n);
      }
      if (!official) { skip.push({ k, n: r.n, why: '取不到官方答案' }); continue; }

      fixed.push({ k, n: r.n, id: r.id, oldAns: q.answer, newAns: official,
        swallowed: q.question.slice(stem.length).trim().slice(0, 34),
        old: optsOf(q.options || {}).map(t => t.slice(0, 16)), neu: srcOpts.map(t => t.slice(0, 16)) });
      if (APPLY) {
        q.question = stem;
        q.options = { A: srcOpts[0], B: srcOpts[1], C: srcOpts[2], D: srcOpts[3] };
        q.answer = official;
        banks[file].dirty = true;
      }
    }
    if (done % 20 === 0) console.log(`  …${done}/${keys.length} 卷，已修 ${fixed.length} 題`);
  }

  const changed = fixed.filter(r => r.oldAns !== r.newAns);
  console.log(`\n可修 ${fixed.length} 題；未處理 ${skip.length}；原卷處理失敗 ${errs} 卷`);
  console.log(`其中答案跟著改變的 ${changed.length} 題`);
  const byWhy = {}; skip.forEach(r => (byWhy[r.why] = (byWhy[r.why] || 0) + 1));
  Object.entries(byWhy).sort((a, b) => b[1] - a[1]).forEach(([w, n]) => console.log(`  ${n} — ${w}`));
  fs.writeFileSync(path.join(BK, '_tmp', 'stem-swallow-plan.json'), JSON.stringify({ fixed, skip }, null, 1), 'utf8');
  fixed.slice(0, 10).forEach(r => console.log(`  ✓ ${r.k} #${r.n} 答 ${r.oldAns}→${r.newAns}\n      題幹多吃的: ${r.swallowed}\n      舊 ${r.old.join(' / ')}\n      新 ${r.neu.join(' / ')}`));
  if (APPLY) {
    let n = 0;
    for (const f of Object.keys(banks)) if (banks[f].dirty) { atomicWriteJson(f, banks[f].raw); n++; }
    console.log(`\n已寫回 ${n} 個題庫檔`);
  } else console.log('\n(試跑；加 --apply 才寫入)');
})().catch(e => { console.error(e.stack); process.exit(1); });
