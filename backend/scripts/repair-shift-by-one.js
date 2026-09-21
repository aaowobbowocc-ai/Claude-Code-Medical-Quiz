#!/usr/bin/env node
/**
 * 修「選項整組位移一格」：題幹尾巴掉進選項 A，原本的 A/B/C 被擠成 B/C/D，D 整個不見。
 *
 *   題幹  His father was
 *   (A) and put in jail as a result of his crime.   ← 其實是題幹的後半
 *   (B) arrested   (C) cheated   (D) elected        ← 原卷的 A/B/C
 *   （原卷的 D「protected」遺失）
 *
 * 光看題庫判斷不出來（453 題符合表面特徵），所以一律回考選部原卷驗：
 * **我們的 B/C/D 必須剛好等於原卷的 A/B/C**。這個簽章很窄，誤判機率低。
 *
 * 命中就整題重建：題幹、四個選項都取原卷。選項位置全變了，舊的答案「字母」失效
 * （原本指的就是位移後的錯位置），一律改用考選部標準答案卷；取不到答案的不動。
 *
 *   node scripts/repair-shift-by-one.js [--exam railway-admin] [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper } = require('./lib/moex-paper-resolve');
const { paperQuestions } = require('./fill-civil-gaps');
const { sheetMap } = require('./lib/moex-answer-geo');
const { skeleton } = require('./lib/moex-normalize');
const { atomicWriteJson } = require('./lib/atomic-write');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const only = (process.argv.find(a => a.startsWith('--exam=')) || '').split('=')[1];
const PUA = /[-]/;
const FILE = e => e === 'doctor1' ? 'questions.json' : `questions-${e}.json`;

/** 表面特徵：便宜的預篩，只用來決定哪些卷值得去抓 PDF */
function suspect(q) {
  const t = String(q.question || '').trim();
  const o = q.options || {};
  const A = String(o.A || '').trim();
  if (!A || A.length < 12) return false;
  if (/[？?。：:！!．.]$/.test(t)) return false;              // 題幹有句尾標點 → 沒被切斷
  if (!/^[a-z]/.test(A) && !/^[一-鿿，,、；;]/.test(A)) return false;
  return A.length > Math.max(String(o.B || '').length, String(o.C || '').length, String(o.D || '').length);
}

// 最後一個選項後面常常緊接著下一段題組的宣告，會被一起收進選項 D
// （railway 101080 國文 #24 的 D 變成「…都比不上的請依下文回答第25題至第27題」）
const DECL_TAIL = /(?:請)?依下[文列]回答第\s*\d{1,3}\s*題.*$|第\s*\d{1,3}\s*題至第\s*\d{1,3}\s*題.*$/;
const optsOf = o => ['A', 'B', 'C', 'D'].map(k => String(o[k] || '').replace(DECL_TAIL, '').trim());
const usable = a => a.every(t => t) && new Set(a).size === 4 && !a.some(t => PUA.test(t));

(async () => {
  const banks = {}, papers = {};
  for (const f of fs.readdirSync(BK).filter(n => /^questions(-[a-z0-9-]*)?\.json$/.test(n))) {
    const exam = f.replace(/^questions-?|\.json$/g, '') || 'doctor1';
    if (only && exam !== only) continue;
    const j = JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8'));
    const arr = Array.isArray(j) ? j : j.questions;
    if (!arr) continue;
    banks[f] = { raw: j, arr, exam };
    for (const q of arr) {
      if (!q.exam_code || !suspect(q)) continue;
      const key = `${exam}|${q.exam_code}|${q.subject}`;
      (papers[key] = papers[key] || { file: f, hits: [] }).hits.push(q);
    }
  }
  const keys = Object.keys(papers);
  console.log(`有嫌疑的卷 ${keys.length} 張，涵蓋 ${keys.reduce((n, k) => n + papers[k].hits.length, 0)} 題\n`);

  const fixed = [], skip = [];
  let errs = 0, done = 0;
  for (const key of keys) {
    done++;
    const [exam, code, subject] = key.split('|');
    const { file, hits } = papers[key];
    const items = banks[file].arr.filter(q => q.exam_code === code && q.subject === subject);
    let src, ans;
    try {
      const p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items });
      if (!p) { hits.forEach(q => skip.push({ key, n: q.number, why: '對不到官方卷' })); continue; }
      src = await paperQuestions(code, p.c, p.s);
      ans = (await sheetMap(code, p.c, p.s, items.length)).map;
    } catch (e) {
      // 整批跑到後段 mupdf 會資源耗盡而每卷都拋；一定要計數，否則整個字母後段會無聲消失
      errs++; hits.forEach(q => skip.push({ key, n: q.number, why: '原卷處理失敗: ' + e.message.slice(0, 40) }));
      continue;
    }
    for (const q of hits) {
      const s = src.get(+q.number);
      if (!s) { skip.push({ key, n: q.number, why: '原卷解析不到該題號' }); continue; }
      const mine = optsOf(q.options || {});
      const srcOpts = optsOf(s.options || {});
      if (!usable(srcOpts)) { skip.push({ key, n: q.number, why: '原卷選項不完整' }); continue; }
      // 位移簽章：我們的 B/C/D == 原卷的 A/B/C
      const shifted = [1, 2, 3].every(i => skeleton(mine[i]) === skeleton(srcOpts[i - 1])) &&
        skeleton(mine[1]).length > 0;
      if (!shifted) { skip.push({ key, n: q.number, why: '不符位移簽章' }); continue; }
      const official = ans.get(+q.number);
      if (!official) { skip.push({ key, n: q.number, why: '取不到官方答案' }); continue; }
      const stem = String(s.stem || '').trim().replace(/ {3,}/g, ' _____ ');
      if (stem.length < 10 || PUA.test(stem)) { skip.push({ key, n: q.number, why: '原卷題幹不可用' }); continue; }

      fixed.push({ key, n: q.number, id: q.id, oldAns: q.answer, newAns: official,
        oldStem: String(q.question).replace(/\s+/g, ' ').slice(0, 40),
        newStem: stem.replace(/\s+/g, ' ').slice(0, 70), opts: srcOpts.map(t => t.slice(0, 18)) });
      if (APPLY) {
        q.question = stem;
        q.options = { A: srcOpts[0], B: srcOpts[1], C: srcOpts[2], D: srcOpts[3] };
        q.answer = official;
        if (q.incomplete === 'broken_options' || q.incomplete === 'cloze_parse_failed') delete q.incomplete;
      }
    }
    if (done % 20 === 0) console.log(`  …${done}/${keys.length} 卷，已確認 ${fixed.length} 題`);
  }

  console.log(`\n符合位移簽章、已重建: ${fixed.length} 題；未處理 ${skip.length} 題；原卷處理失敗 ${errs} 卷`);
  const byWhy = {}; skip.forEach(r => (byWhy[r.why] = (byWhy[r.why] || 0) + 1));
  Object.entries(byWhy).sort((a, b) => b[1] - a[1]).forEach(([w, n]) => console.log(`  ${n} 題 — ${w}`));
  const changed = fixed.filter(r => r.oldAns !== r.newAns).length;
  console.log(`\n其中答案跟著改變的 ${changed} 題（位移後舊字母本來就指錯位置）`);
  fs.writeFileSync(path.join(BK, '_tmp', 'shift-by-one.json'), JSON.stringify({ fixed, skip }, null, 1), 'utf8');
  fixed.slice(0, 12).forEach(r => console.log(`  ✓ ${r.key} #${r.n} 答 ${r.oldAns}→${r.newAns}\n      ${r.newStem}\n      ${r.opts.join(' / ')}`));

  if (APPLY) {
    const files = new Set(fixed.map(r => papers[r.key].file));
    for (const f of files) atomicWriteJson(path.join(BK, f), banks[f].raw);
    console.log(`\n已寫回 ${files.size} 個題庫檔`);
  } else console.log('\n(試跑；加 --apply 才寫入)');
})().catch(e => { console.error(e.stack); process.exit(1); });
