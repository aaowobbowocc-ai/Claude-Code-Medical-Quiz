#!/usr/bin/env node
/**
 * 修英文題「看不出要填哪裡」的題幹。
 *
 *   我們的：She was                              ← 整句被截掉
 *   或    ：She wasfor the scholarship because…   ← 空格被 trim 掉，黏成一個字
 *   原卷  ：She was _____ for the scholarship because…
 *
 * 成因是解析時把 run 之間的水平間隙（就是印在卷上的底線）trim 掉了。
 * `fill-civil-gaps.js` 的 `appendRun()` 現在會依間隙寬度還原成 `_____`，
 * 這支就是拿新的解析結果把既有題幹換回來。
 *
 * 兩種都修：
 *   1. 我們的題幹是原卷題幹的開頭（被截斷）→ 換成原卷的
 *   2. 去掉空白與底線後兩者相同（只差空格標記）→ 換成原卷的
 * 兩種都要求**選項集合一致**，否則代表根本不是同一題，不動。
 *
 *   node scripts/repair-english-blanks.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper } = require('./lib/moex-paper-resolve');
const { paperQuestions } = require('./fill-civil-gaps');
const { skeleton, optionKey } = require('./lib/moex-normalize');
const { atomicWriteJson } = require('./lib/atomic-write');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const optsOf = o => ['A', 'B', 'C', 'D'].map(k => String(o[k] || '').trim());
const sameOpts = (a, b) => a.every(Boolean) && b.every(Boolean)
  && a.map(optionKey).join('|') === b.map(optionKey).join('|');

(async () => {
  const banks = {}, groups = {};
  for (const f of fs.readdirSync(BK).filter(n => /^questions(-[a-z0-9-]*)?\.json$/.test(n))) {
    const exam = f.replace(/^questions-?|\.json$/g, '') || 'doctor1';
    const p = path.join(BK, f);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = Array.isArray(raw) ? raw : raw.questions;
    if (!arr) continue;
    banks[p] = { raw, arr, dirty: false };
    for (const q of arr) {
      if (!q.exam_code || !/英文/.test(String(q.subject || ''))) continue;
      const k = `${exam}|${q.exam_code}|${q.subject}`;
      (groups[k] = groups[k] || { file: p, exam, items: [] }).items.push(q);
    }
  }

  const keys = Object.keys(groups);
  console.log(`英文卷 ${keys.length} 張\n`);
  const fixed = [], skip = [];
  let errs = 0, done = 0;
  for (const k of keys) {
    done++;
    const [exam, code, subject] = k.split('|');
    const g = groups[k];
    let src;
    try {
      const p = await resolvePaper({ exam, code, subject, year: String(code).slice(0, 3), items: g.items });
      if (!p) { skip.push({ k, why: '對不到官方卷', n: g.items.length }); continue; }
      src = await paperQuestions(code, p.c, p.s);
    } catch (e) { errs++; skip.push({ k, why: '原卷處理失敗: ' + e.message.slice(0, 40), n: g.items.length }); continue; }

    for (const q of g.items) {
      const s = src.get(+q.number);
      if (!s) continue;
      // 還原出來的空格標記後面若緊接標點，會多一個空白（"personal _____ , she"）
      const stem = String(s.stem || '').trim().replace(/ +([,.;:?!])/g, '$1');
      if (!stem || stem.length < 12) continue;
      const ours = String(q.question || '').trim();
      if (ours === stem) continue;
      const a = skeleton(ours), b = skeleton(stem);
      const truncated = b.startsWith(a) && b.length > a.length;
      const sameText = a === b && /_{3,}/.test(stem) && !/_{3,}/.test(ours);
      if (!truncated && !sameText) continue;
      if (!sameOpts(optsOf(q.options || {}), optsOf(s.options || {}))) {
        skip.push({ k, n: q.number, why: '選項對不上，不是同一題' }); continue;
      }
      fixed.push({ k, n: q.number, id: q.id, kind: truncated ? '截斷' : '缺空格標記',
        before: ours.replace(/\s+/g, ' ').slice(0, 56), after: stem.replace(/\s+/g, ' ').slice(0, 76) });
      if (APPLY) { q.question = stem; banks[g.file].dirty = true; }
    }
    if (done % 20 === 0) console.log(`  …${done}/${keys.length} 卷，已修 ${fixed.length} 題`);
  }

  const byKind = {}; fixed.forEach(r => (byKind[r.kind] = (byKind[r.kind] || 0) + 1));
  console.log(`\n可修 ${fixed.length} 題 ${JSON.stringify(byKind)}；跳過 ${skip.length}；原卷處理失敗 ${errs} 卷`);
  const byWhy = {}; skip.forEach(r => (byWhy[r.why] = (byWhy[r.why] || 0) + 1));
  Object.entries(byWhy).sort((a, b) => b[1] - a[1]).forEach(([w, n]) => console.log(`  ${n} — ${w}`));
  fs.writeFileSync(path.join(BK, '_tmp', 'english-blank-plan.json'), JSON.stringify({ fixed, skip }, null, 1), 'utf8');
  fixed.slice(0, 10).forEach(r => console.log(`  ✓ ${r.k} #${r.n} [${r.kind}]\n      前: ${r.before}\n      後: ${r.after}`));
  if (APPLY) {
    let n = 0;
    for (const p of Object.keys(banks)) if (banks[p].dirty) { atomicWriteJson(p, banks[p].raw); n++; }
    console.log(`\n已寫回 ${n} 個題庫檔`);
  } else console.log('\n(試跑；加 --apply 才寫入)');
})().catch(e => { console.error(e.stack); process.exit(1); });
