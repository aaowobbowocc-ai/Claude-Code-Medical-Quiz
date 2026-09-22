#!/usr/bin/env node
/**
 * 把共用題庫的題幹同步成主題庫那一份（主題庫修過很多輪，共用那份沒跟上）。
 *
 * 起因：英文填空題的空格還原（repair-english-blanks.js）只修到主題庫，
 * `common_english` 裡同一批題仍然是「She was」「The storm caused」這種看不出要填哪裡的題幹。
 *
 * 配對用「年份 + 題號 + 科目」，再要求四個選項至少兩個吻合。
 * 不能只用選項集合當鍵——共用那份的選項排版可能有細微差異，會一題都配不到（實測只配到 3 題）。
 * 也不能只靠題幹前綴：題幹壞掉時前綴本來就對不上（"She was" vs 完整句）。
 * 只有主題庫那份**更長**或**有空格標記而我們沒有**時才覆蓋，不會反向把好的改壞。
 *
 *   node scripts/sync-shared-bank-stems.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const { skeleton, optionKey } = require('./lib/moex-normalize');
const { atomicWriteJson } = require('./lib/atomic-write');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const SOURCES = { police: 'questions-police.json', customs: 'questions-customs.json', police4: 'questions-police4.json' };

const optsOf = o => ['A', 'B', 'C', 'D'].map(k => String(o[k] || '').trim());
const optKey = o => optsOf(o).map(optionKey).join('|');

const mainIdx = {};
for (const [src, f] of Object.entries(SOURCES)) {
  const p = path.join(BK, f);
  if (!fs.existsSync(p)) continue;
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const arr = Array.isArray(j) ? j : j.questions;
  const idx = new Map();
  for (const q of arr) {
    const opts = optsOf(q.options || {});
    if (!opts.every(Boolean)) continue;
    idx.set(`${String(q.exam_code || '').slice(0, 3)}|${q.number}|${q.subject}`, q);
  }
  mainIdx[src] = idx;
  console.log(`${src} 主題庫索引 ${idx.size} 題`);
}

const plan = [], banks = {};
for (const f of fs.readdirSync(path.join(BK, 'shared-banks')).filter(n => /\.json$/.test(n))) {
  const p = path.join(BK, 'shared-banks', f);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const arr = Array.isArray(raw) ? raw : raw.questions;
  if (!arr) continue;
  banks[p] = { raw, dirty: false };
  for (const q of arr) {
    const idx = mainIdx[q.source_exam_code];
    if (!idx) continue;
    const opts = optsOf(q.options || {});
    if (!opts.every(Boolean)) continue;
    const m = idx.get(`${q.roc_year}|${q.number}|${q.subject}`);
    if (!m) continue;
    // 年份+題號+科目可能撞到別題，所以要求四個選項至少兩個吻合才算同一題
    const mine = opts.map(optionKey), theirsOpt = optsOf(m.options || {}).map(optionKey);
    if (mine.filter(t => theirsOpt.includes(t)).length < 2) continue;
    const ours = String(q.question || '').trim(), theirs = String(m.question || '').trim();
    if (theirs.length < 12) continue;
    // 第三種情況：共用那份的題幹根本是選項碎片（「looking after」），主題庫那份
    // 已經把題組文章補進去了。這種時候「我們的是對方的前綴」不會成立，
    // 但年份+題號+科目+兩個選項吻合已經足以確認是同一題，直接採用較完整的那份。
    const fragment = ours.length < 40 && !/[？?]$/.test(ours) && theirs.length > ours.length * 3;
    const stemBetter = ours !== theirs && (
      skeleton(theirs).startsWith(skeleton(ours)) && theirs.length > ours.length
      || (/_{3,}/.test(theirs) && !/_{3,}/.test(ours) && skeleton(theirs) === skeleton(ours))
      || fragment);
    // 選項也可能沒跟上主題庫（common_chinese 115 #4 的選項 A 是題幹本身，整組位移一格）。
    // 這個檢查要獨立於題幹——題幹已經同步過的題還是可能留著壞掉的選項。
    const mainOpts = optsOf(m.options || {});
    const optDiff = mainOpts.every(Boolean)
      && new Set(mainOpts.map(optionKey)).size === 4
      && mainOpts.map(optionKey).join('|') !== opts.map(optionKey).join('|');
    if (!stemBetter && !optDiff) continue;

    plan.push({ file: f, id: q.id, year: q.roc_year, n: q.number, stemBetter, optDiff,
      before: ours.replace(/\s+/g, ' ').slice(0, 50), after: theirs.replace(/\s+/g, ' ').slice(0, 70) });
    if (APPLY) {
      if (stemBetter) q.question = theirs;
      // 選項位置變了，答案字母跟著主題庫走
      if (optDiff) { q.options = { A: mainOpts[0], B: mainOpts[1], C: mainOpts[2], D: mainOpts[3] }; q.answer = m.answer; }
      banks[p].dirty = true;
    }
  }
}

console.log(`\n題幹可同步：${plan.length} 題`);
const by = {}; plan.forEach(r => (by[r.file] = (by[r.file] || 0) + 1));
Object.entries(by).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k} ${v}`));
fs.writeFileSync(path.join(BK, '_tmp', 'shared-stem-sync.json'), JSON.stringify(plan, null, 1), 'utf8');
plan.slice(0, 8).forEach(r => console.log(`  ✓ ${r.file} ${r.year} #${r.n}\n      前: ${r.before}\n      後: ${r.after}`));
if (APPLY) {
  let n = 0;
  for (const p of Object.keys(banks)) if (banks[p].dirty) { atomicWriteJson(p, banks[p].raw); n++; }
  console.log(`\n已寫回 ${n} 個共用題庫`);
} else console.log('\n(試跑；加 --apply 才寫入)');
