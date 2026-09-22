#!/usr/bin/env node
/**
 * 修「選項被全形括號切開」的題。
 *
 *   (A) 世界競爭力（World Competitiveness    ← 左括號沒有右括號
 *   (B) ）                                    ← 只剩一個右括號
 *   (C) 世界自由度（Freedom in the World
 *   (D) ）
 *
 * 原卷其實是四個完整選項。使用者回報 #937（普考 107 行政學概要 #37）就是這型，
 * 而且因為選項錯位，存的答案字母（D）也指到錯的地方（官方是 C）。
 *
 * 判準：某個選項只剩右括號、左右括號數不相等、選項空白，或兩個選項實質重複。
 * 這幾種都是同一批版型問題的不同面孔。
 * 修法：整組選項改用原卷的，答案改用考選部標準答案卷——選項位置都變了，舊字母不可信。
 * 題幹原則上不動，只有在「原卷題幹是我們題幹的延伸、且延伸的那段不是選項文字」時才補。
 *
 *   node scripts/repair-paren-split-options.js [--bank admin_studies_junior] [--apply]
 */
const fs = require('fs');
const path = require('path');
const { resolvePaper } = require('./lib/moex-paper-resolve');
const { paperQuestions } = require('./fill-civil-gaps');
const { sheetMap } = require('./lib/moex-answer-geo');
const { skeleton, optionKey } = require('./lib/moex-normalize');
const { atomicWriteJson } = require('./lib/atomic-write');
// 普考行政學／行政法的年份→場次代號與 c/s，權威在爬蟲那支
const { SESSIONS, SUBJECTS } = require('./scrape-civil-junior-admin');

const BK = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const onlyBank = (process.argv.find(a => a.startsWith('--bank=')) || '').split('=')[1];
const PUA = /[-]/;

const optsOf = o => ['A', 'B', 'C', 'D'].map(k => String(o[k] || '').trim());
const balanced = t => (t.match(/[（(]/g) || []).length === (t.match(/[）)]/g) || []).length;
const usable = a => a.length === 4 && a.every(t => t) && new Set(a.map(t => optionKey(t))).size === 4
  && !a.some(t => PUA.test(t)) && a.every(balanced);
/**
 * 這一題的選項是不是壞的。原本只看括號被切開，後來發現「選項重複／空白」
 * 是同一批版型問題的另一個面孔，修法與防呆完全一樣，就一起收進來。
 * 判重複要用 optionKey（只折疊全形半形），不能用 skeleton——skeleton 連標點都刪，
 * 會把「3.44 cm」和「344 cm」判成重複，一口氣誤判 267 題好題。
 */
const brokenOptions = a => a.some(t => /^[）)]$/.test(t)) || a.some(t => !balanced(t))
  || a.some(t => !t) || new Set(a.map(t => optionKey(t))).size !== 4;

/** 普考共用題庫的一筆 → 該卷的 {code,c,s}；對不到回 null */
function juniorPaper(q, bankKey) {
  const ses = SESSIONS.find(x => x.year === String(q.roc_year));
  if (!ses) return null;
  const sub = SUBJECTS.find(x => x.bank === bankKey && (!x.onlyYears || x.onlyYears.includes(String(q.roc_year))));
  if (!sub) return null;
  return { code: ses.code, c: sub.c, s: sub.s };
}

(async () => {
  const targets = [];   // {label, file, isShared, items:[q], paper:{code,c,s}|null, meta}

  // --- 共用題庫（普考行政學／行政法）：卷別靠爬蟲的對照表 ---
  for (const [bankKey, file] of [['admin_studies', 'common_admin_studies_junior.json'], ['admin_law', 'common_admin_law_junior.json']]) {
    if (onlyBank && !file.includes(onlyBank)) continue;
    const p = path.join(BK, 'shared-banks', file);
    if (!fs.existsSync(p)) continue;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = Array.isArray(raw) ? raw : raw.questions;
    const groups = {};
    for (const q of arr) {
      if (!brokenOptions(optsOf(q.options || {}))) continue;
      const pr = juniorPaper(q, bankKey);
      if (!pr) continue;
      const k = `${pr.code}|${pr.c}|${pr.s}`;
      (groups[k] = groups[k] || { paper: pr, items: [] }).items.push(q);
    }
    for (const k of Object.keys(groups))
      targets.push({ label: `${file} ${k}`, file: p, raw, arr, ...groups[k], expected: 50 });
  }

  // --- 一般題庫：卷別用 resolvePaper ---
  if (!onlyBank) {
    for (const f of fs.readdirSync(BK).filter(n => /^questions(-[a-z0-9-]*)?\.json$/.test(n))) {
      const exam = f.replace(/^questions-?|\.json$/g, '') || 'doctor1';
      const p = path.join(BK, f);
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const arr = Array.isArray(raw) ? raw : raw.questions;
      if (!arr) continue;
      const groups = {};
      for (const q of arr) {
        if (!q.exam_code || !brokenOptions(optsOf(q.options || {}))) continue;
        const k = `${q.exam_code}|${q.subject}`;
        (groups[k] = groups[k] || []).push(q);
      }
      for (const k of Object.keys(groups)) {
        const [code, subject] = k.split('|');
        targets.push({ label: `${exam} ${code} ${subject}`, file: p, raw, arr, exam, code, subject,
          items: groups[k], paper: null, all: arr.filter(q => q.exam_code === code && q.subject === subject) });
      }
    }
  }

  console.log(`要處理 ${targets.length} 張卷、${targets.reduce((n, t) => n + t.items.length, 0)} 題\n`);
  const fixed = [], skip = [];
  let errs = 0, done = 0;

  for (const t of targets) {
    done++;
    let src, ans;
    try {
      let pr = t.paper;
      if (!pr) {
        const r = await resolvePaper({ exam: t.exam, code: t.code, subject: t.subject, year: String(t.code).slice(0, 3), items: t.all });
        if (!r) { t.items.forEach(q => skip.push({ label: t.label, n: q.number, why: '對不到官方卷' })); continue; }
        pr = { code: t.code, c: r.c, s: r.s };
      }
      src = await paperQuestions(pr.code, pr.c, pr.s);
      ans = (await sheetMap(pr.code, pr.c, pr.s, t.expected || (t.all ? t.all.length : 50))).map;
    } catch (e) {
      // 批次跑到後段 mupdf 會資源耗盡而每卷都拋，一定要計數，否則整批會無聲消失
      errs++; t.items.forEach(q => skip.push({ label: t.label, n: q.number, why: '原卷處理失敗: ' + e.message.slice(0, 40) }));
      continue;
    }
    for (const q of t.items) {
      const s = src.get(+q.number);
      if (!s) { skip.push({ label: t.label, n: q.number, why: '原卷解析不到該題號' }); continue; }
      // 確認是同一題才敢改選項——題號對不上就換掉選項等於製造一筆全新的壞題
      const a = skeleton(q.question), b = skeleton(s.stem || '');
      if (!a || !b || !(a.startsWith(b.slice(0, 20)) || b.startsWith(a.slice(0, 20)))) {
        skip.push({ label: t.label, n: q.number, why: '題幹與原卷對不上' }); continue;
      }
      const srcOpts = optsOf(s.options || {});
      if (!usable(srcOpts)) { skip.push({ label: t.label, n: q.number, why: '原卷選項也不完整' }); continue; }
      const official = ans.get(+q.number);
      if (!official) { skip.push({ label: t.label, n: q.number, why: '取不到官方答案' }); continue; }

      // 題幹常常也被一起切斷——後半段（例如 ③ 的尾巴與 ④ 整項）漏進了選項。
      // 只修選項會留下一題看不到 ④ 卻要選「③④」的壞題（nursing 105030 #35 實測）。
      // 只有在「原卷題幹是我們題幹的延伸」時才補，避免換成別題的題幹。
      const skelOptA = skeleton(srcOpts[0]);
      // 有些卷的題幹行後面直接黏著前兩個選項，照補會把選項文字寫進題幹
      // （clinical-psychology 101030 #21、dental-tech 111110 #19 實測）。
      // 補回來的那一段若含選項 A 的文字，就不是題幹。
      const extended = b.startsWith(a) && b.length > a.length && !b.slice(a.length).includes(skelOptA);
      fixed.push({ label: t.label, n: q.number, id: q.id, oldAns: q.answer, newAns: official, stemFixed: extended,
        old: optsOf(q.options || {}).map(x => x.slice(0, 16)), neu: srcOpts.map(x => x.slice(0, 16)) });
      if (APPLY) {
        q.options = { A: srcOpts[0], B: srcOpts[1], C: srcOpts[2], D: srcOpts[3] };
        q.answer = official;
        if (extended) q.question = String(s.stem).trim();
        t.dirty = true;
      }
    }
    if (done % 20 === 0) console.log(`  …${done}/${targets.length} 卷，已修 ${fixed.length} 題`);
  }

  const changed = fixed.filter(r => r.oldAns !== r.newAns);
  console.log(`\n可修 ${fixed.length} 題；未處理 ${skip.length} 題；原卷處理失敗 ${errs} 卷`);
  console.log(`其中答案跟著改變的 ${changed.length} 題`);
  const byWhy = {}; skip.forEach(r => (byWhy[r.why] = (byWhy[r.why] || 0) + 1));
  Object.entries(byWhy).sort((a, b) => b[1] - a[1]).forEach(([w, n]) => console.log(`  ${n} 題 — ${w}`));
  fs.writeFileSync(path.join(BK, '_tmp', 'paren-split-plan.json'), JSON.stringify({ fixed, skip }, null, 1), 'utf8');
  changed.slice(0, 15).forEach(r => console.log(`  ⚠ ${r.label} #${r.n} 答 ${r.oldAns}→${r.newAns}\n      舊 ${r.old.join(' / ')}\n      新 ${r.neu.join(' / ')}`));

  if (APPLY) {
    const files = [...new Set(targets.filter(t => t.dirty).map(t => t.file))];
    for (const f of files) {
      const t = targets.find(x => x.file === f);
      atomicWriteJson(f, t.raw);
    }
    console.log(`\n已寫回 ${files.length} 個檔`);
  } else console.log('\n(試跑；加 --apply 才寫入)');
})().catch(e => { console.error(e.stack); process.exit(1); });
